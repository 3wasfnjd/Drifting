import * as THREE from 'three';
import { createImpactBuffer } from './ImpactSound.js';
import { RPM_IDLE, RPM_MAX } from './EngineWorklet.js';

function remap( value, inMin, inMax, outMin, outMax ) {
	return outMin + ( outMax - outMin ) * ( ( value - inMin ) / ( inMax - inMin ) );
}

const NUM_GEARS = 3;
const UPSHIFT_RPM = 0.92;
const DOWNSHIFT_RPM = 0.35;
const SHIFT_COOLDOWN = 0.35;
const SHIFT_CUT = 0.12;
const IMPACT_HARD_VELOCITY = 2.5;
const IMPACT_MAX_VELOCITY = 6;
const REF_DISTANCE = 7;
const ENGINE_REF_DISTANCE = 11;
const ENGINE_CUTOFF = 5500;
const _listenerPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();

function distanceCutoff( distance ) {
	return THREE.MathUtils.clamp( 24000 * Math.pow( 6 / Math.max( distance, 6 ), 1.9 ), 1200, 24000 );
}

function createOutdoorIR( context ) {
	const sr = context.sampleRate;
	const length = Math.floor( 1.1 * sr );
	const buffer = context.createBuffer( 2, length, sr );
	for ( let ch = 0; ch < 2; ch ++ ) {
		const data = buffer.getChannelData( ch );
		for ( let r = 0; r < 8; r ++ ) {
			const t = 0.015 + Math.random() * 0.08;
			data[ Math.floor( t * sr ) ] += ( Math.random() * 2 - 1 ) * ( 0.5 - r * 0.05 );
		}
		let lp = 0;
		const lpCoeff = 1 - Math.exp( - 2 * Math.PI * 2200 / sr );
		const start = Math.floor( 0.05 * sr );
		for ( let i = start; i < length; i ++ ) {
			const t = ( i - start ) / sr;
			lp += ( Math.random() * 2 - 1 - lp ) * lpCoeff;
			data[ i ] += lp * Math.exp( - t / 0.32 ) * 0.35;
		}
	}
	return buffer;
}

export class GameAudio {
	constructor() {
		this.listener = null;
		this.target = null;
		this.reverbSend = null;
		this.impactReverbSend = null;
		this.engineReverbSend = null;
		this.engineGain = null;
		this.engineRpmParam = null;
		this.engineLoadParam = null;
		this.skidSound = null;
		this.skidTone = null;
		this.impactBuffers = [];
		this.impactPlayers = [];
		this.impactIndex = 0;
		this.distanceFilters = [];
		this.unlocked = false;
		this.rpm = 0;
		this.gear = 0;
		this.shiftCooldown = 0;
		this.roadRunnerMode = false;
		this.roadRunnerWasMoving = false;
	}

	init( camera, target ) {
		this.listener = new THREE.AudioListener();
		camera.add( this.listener );
		this.target = target;
		const ctx = this.listener.context;
		const convolver = ctx.createConvolver();
		convolver.buffer = createOutdoorIR( ctx );
		convolver.connect( this.listener.getInput() );
		this.reverbSend = ctx.createGain();
		this.reverbSend.gain.value = 0.15;
		this.reverbSend.connect( convolver );
		this.impactReverbSend = ctx.createGain();
		this.impactReverbSend.gain.value = 0.35;
		this.impactReverbSend.connect( convolver );
		this.engineReverbSend = ctx.createGain();
		this.engineReverbSend.gain.value = 0.11;
		this.engineReverbSend.connect( convolver );
		this.initEngine().catch( ( e ) => console.warn( 'Engine synth unavailable:', e ) );
		const skid = this.createSampleSource( this.reverbSend );
		this.skidSound = skid.sound;
		this.skidTone = skid.tone;
		for ( let i = 0; i < 3; i ++ ) this.impactBuffers.push( createImpactBuffer( ctx, i + 1, 0.4 ) );
		for ( let i = 0; i < 3; i ++ ) this.impactBuffers.push( createImpactBuffer( ctx, i + 4, 1.0 ) );
		for ( let i = 0; i < 3; i ++ ) this.impactPlayers.push( this.createSampleSource( this.impactReverbSend ) );
		const loader = new THREE.AudioLoader();
		loader.load( 'audio/skid.ogg', ( buffer ) => {
			this.skidSound.setBuffer( buffer );
			this.skidSound.setLoop( true );
			this.skidSound.setVolume( 0 );
			if ( this.unlocked ) this.startSounds();
		} );
		const unlock = () => {
			if ( this.unlocked ) return;
			this.unlocked = true;
			if ( ctx.state === 'suspended' ) ctx.resume();
			this.startSounds();
			window.removeEventListener( 'keydown', unlock );
			window.removeEventListener( 'click', unlock );
			window.removeEventListener( 'touchstart', unlock );
		};
		window.addEventListener( 'keydown', unlock );
		window.addEventListener( 'click', unlock );
		window.addEventListener( 'touchstart', unlock );
		document.addEventListener( 'visibilitychange', () => {
			if ( document.hidden ) {
				if ( ctx.state === 'running' ) ctx.suspend();
			} else if ( this.unlocked && ctx.state === 'suspended' ) ctx.resume();
		} );
	}

	setRoadRunnerMode( enabled ) {
		this.roadRunnerMode = enabled;
		if ( ! enabled ) this.roadRunnerWasMoving = false;
	}

	playRoadRunnerBeep() {
		if ( ! this.unlocked || ! this.listener ) return;
		const ctx = this.listener.context;
		const now = ctx.currentTime;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime( 0.0001, now );
		gain.gain.exponentialRampToValueAtTime( 0.24, now + 0.004 );
		gain.gain.exponentialRampToValueAtTime( 0.0001, now + 0.135 );
		gain.connect( this.listener.getInput() );
		const beep = ( start, frequency ) => {
			const osc = ctx.createOscillator();
			osc.type = 'square';
			osc.frequency.setValueAtTime( frequency, now + start );
			osc.connect( gain );
			osc.start( now + start );
			osc.stop( now + start + 0.042 );
		};
		beep( 0, 1260 );
		beep( 0.054, 1510 );
	}

	async initEngine() {
		const ctx = this.listener.context;
		await ctx.audioWorklet.addModule( new URL( './EngineWorklet.js', import.meta.url ) );
		const node = new AudioWorkletNode( ctx, 'engine-sound', { numberOfInputs: 0, outputChannelCount: [ 1 ] } );
		this.engineGain = ctx.createGain();
		this.engineGain.gain.value = 0;
		node.connect( this.engineGain );
		const tone = this.neutralLowpass();
		tone.frequency.value = ENGINE_CUTOFF;
		const audio = new THREE.PositionalAudio( this.listener );
		audio.setRefDistance( ENGINE_REF_DISTANCE );
		audio.panner.panningModel = 'equalpower';
		audio.setFilter( tone );
		audio.setNodeSource( this.engineGain );
		this.target.add( audio );
		this.engineGain.connect( this.engineReverbSend );
		this.engineRpmParam = node.parameters.get( 'rpm' );
		this.engineLoadParam = node.parameters.get( 'load' );
	}

	neutralLowpass() {
		const filter = this.listener.context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.Q.value = 0.0001;
		filter.frequency.value = 24000;
		return filter;
	}

	makePositional( filters ) {
		const audio = new THREE.PositionalAudio( this.listener );
		audio.setRefDistance( REF_DISTANCE );
		audio.panner.panningModel = 'equalpower';
		audio.setFilters( filters );
		this.distanceFilters.push( filters[ 0 ] );
		this.target.add( audio );
		return audio;
	}

	createSampleSource( reverbSend ) {
		const tone = this.neutralLowpass();
		const audio = this.makePositional( [ this.neutralLowpass(), tone ] );
		audio.gain.connect( reverbSend );
		return { sound: audio, tone };
	}

	startSounds() {
		if ( this.skidSound.buffer && ! this.skidSound.isPlaying ) this.skidSound.play();
	}

	update( dt, speed, throttle, driftIntensity ) {
		const absSpeed = THREE.MathUtils.clamp( Math.abs( speed ), 0, 1 );
		const load = THREE.MathUtils.clamp( Math.max( 0, throttle ), 0, 1 );
		const now = this.listener.context.currentTime;
		if ( this.roadRunnerMode ) {
			if ( this.engineGain ) this.engineGain.gain.setTargetAtTime( 0, now, 0.025 );
			if ( this.skidSound?.buffer ) this.skidSound.gain.gain.setTargetAtTime( 0, now, 0.025 );
			const moving = absSpeed > 0.10;
			if ( moving && ! this.roadRunnerWasMoving ) this.playRoadRunnerBeep();
			if ( absSpeed < 0.035 ) this.roadRunnerWasMoving = false;
			else if ( moving ) this.roadRunnerWasMoving = true;
			return;
		}
		const gearWindow = 1 / NUM_GEARS;
		const gearStart = this.gear * gearWindow;
		const inGear = THREE.MathUtils.clamp( ( absSpeed - gearStart ) / gearWindow, 0, 1 );
		let targetRpm = THREE.MathUtils.clamp( inGear * 0.85 + load * 0.2, 0, 1.05 );
		const rate = targetRpm > this.rpm ? ( 4 * ( 0.3 + load ) ) : 4;
		this.rpm = THREE.MathUtils.lerp( this.rpm, targetRpm, Math.min( 1, dt * rate ) );
		this.shiftCooldown = Math.max( 0, this.shiftCooldown - dt );
		if ( this.shiftCooldown === 0 ) {
			if ( this.rpm > UPSHIFT_RPM && this.gear < NUM_GEARS - 1 && load > 0.1 ) {
				this.gear ++;
				this.rpm = 0.45;
				this.shiftCooldown = SHIFT_COOLDOWN;
			} else if ( this.rpm < DOWNSHIFT_RPM && this.gear > 0 ) {
				this.gear --;
				this.rpm = 0.78;
				this.shiftCooldown = SHIFT_COOLDOWN;
			}
		}
		this.listener.getWorldPosition( _listenerPos );
		this.target.getWorldPosition( _targetPos );
		const cutoff = distanceCutoff( _listenerPos.distanceTo( _targetPos ) );
		for ( const filter of this.distanceFilters ) filter.frequency.setTargetAtTime( cutoff, now, 0.1 );
		if ( this.engineRpmParam ) {
			const shifting = this.shiftCooldown > SHIFT_COOLDOWN - SHIFT_CUT;
			this.engineRpmParam.value = RPM_IDLE + ( RPM_MAX - RPM_IDLE ) * this.rpm;
			this.engineLoadParam.value = shifting ? 0 : load;
			const targetVol = remap( absSpeed + load * 0.5, 0, 1.5, 0.06, 0.3 );
			this.engineGain.gain.setTargetAtTime( targetVol, now, 0.08 );
		}
		if ( this.skidSound.buffer ) {
			let skidVol = 0;
			if ( driftIntensity > 0.5 ) skidVol = remap( THREE.MathUtils.clamp( driftIntensity, 0.5, 2.0 ), 0.5, 2.0, 0.08, 0.35 );
			this.skidSound.gain.gain.setTargetAtTime( skidVol, now, 0.05 );
			const skidPitch = THREE.MathUtils.clamp( Math.abs( speed ), 1, 3 );
			this.skidSound.setPlaybackRate( THREE.MathUtils.lerp( this.skidSound.getPlaybackRate(), skidPitch, 0.1 ) );
			const intensity01 = THREE.MathUtils.clamp( remap( driftIntensity, 0.5, 1.6, 0, 1 ), 0, 1 );
			this.skidTone.frequency.setTargetAtTime( 2500 + intensity01 * 7500, now, 0.1 );
		}
	}

	playImpact( impactVelocity ) {
		if ( ! this.unlocked ) return;
		const { sound, tone } = this.impactPlayers[ this.impactIndex % this.impactPlayers.length ];
		this.impactIndex ++;
		const set = impactVelocity < IMPACT_HARD_VELOCITY ? 0 : 3;
		const buffer = this.impactBuffers[ set + ( Math.random() * 3 | 0 ) ];
		if ( sound.isPlaying ) sound.stop();
		sound.setBuffer( buffer );
		const volume = THREE.MathUtils.clamp( remap( impactVelocity, 0, IMPACT_MAX_VELOCITY, 0.01, 1.0 ), 0.01, 1.0 );
		sound.setVolume( volume );
		sound.setPlaybackRate( 0.9 + Math.random() * 0.2 );
		const brightness = THREE.MathUtils.clamp( impactVelocity / IMPACT_MAX_VELOCITY, 0, 1 );
		tone.frequency.value = ( 2500 + brightness * 9000 ) * ( 0.8 + Math.random() * 0.4 );
		sound.play();
		sound.updateMatrixWorld( true );
	}
}
