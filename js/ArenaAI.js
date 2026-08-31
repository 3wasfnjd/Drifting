import * as THREE from 'three';
import { rigidBody } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { createSphereBody } from './Physics.js';

function normalizeAngle( x ) {
	return ( ( ( x + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) ) - Math.PI;
}

const _forward = new THREE.Vector3();
function headingY( vehicle ) {
	_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
	return Math.atan2( _forward.x, _forward.z );
}

export function createArenaAI( { world, parent, models, center = new THREE.Vector3(), scale = 1, count = 3 } ) {
	const keys = [ 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red' ];
	const drivers = [];
	const radius = 0.5 * scale;
	for ( let i = 0; i < count; i ++ ) {
		const a = i / count * Math.PI * 2;
		const r = 10 * scale;
		const pos = [ center.x + Math.cos( a ) * r, center.y + radius, center.z + Math.sin( a ) * r ];
		const body = createSphereBody( world, pos, radius );
		const vehicle = new Vehicle();
		vehicle.rigidBody = body;
		vehicle.physicsWorld = world;
		vehicle.visualOffset = radius;
		vehicle.sphereRadius = radius;
		vehicle.spawnPos.set( ...pos );
		vehicle.spherePos.set( ...pos );
		vehicle.prevModelPos.set( pos[ 0 ], center.y, pos[ 2 ] );
		const group = vehicle.init( models[ keys[ i % keys.length ] ] );
		if ( scale !== 1 ) group.scale.setScalar( scale );
		parent.add( group );
		drivers.push( {
			vehicle,
			center: center.clone(),
			scale,
			aiState: 'CRUISING',
			stateTimer: 1.5 + Math.random() * 2.5,
			target: center.clone(),
			sampleTimer: 0,
			stuckStrikes: 0,
		} );
	}
	return drivers;
}

export function updateArenaAI( drivers, dt, arenaRadius ) {
	for ( const d of drivers ) {
		const v = d.vehicle;
		const limit = arenaRadius * d.scale * 0.90;
		const wander = arenaRadius * d.scale * 0.72;
		d.sampleTimer += dt;
		if ( d.sampleTimer >= 0.5 ) {
			d.sampleTimer = 0;
			const moved = Math.hypot( v.spherePos.x - ( d.sampleX ?? v.spherePos.x ), v.spherePos.z - ( d.sampleZ ?? v.spherePos.z ) );
			d.sampleX = v.spherePos.x; d.sampleZ = v.spherePos.z;
			d.stuckStrikes = moved < 0.12 * d.scale ? d.stuckStrikes + 1 : 0;
		}
		if ( d.stuckStrikes >= 4 ) {
			const a = Math.random() * Math.PI * 2;
			const r = wander * 0.35;
			const px = d.center.x + Math.cos( a ) * r;
			const pz = d.center.z + Math.sin( a ) * r;
			rigidBody.setPosition( v.physicsWorld, v.rigidBody, [ px, d.center.y + v.sphereRadius, pz ], false );
			rigidBody.setLinearVelocity( v.physicsWorld, v.rigidBody, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( v.physicsWorld, v.rigidBody, [ 0, 0, 0 ] );
			v.spherePos.set( px, d.center.y + v.sphereRadius, pz );
			v.linearSpeed = 0;
			d.stuckStrikes = 0;
			d.aiState = 'CRUISING';
			d.stateTimer = 2;
		}

		d.stateTimer -= dt;
		const dxCenter = v.spherePos.x - d.center.x;
		const dzCenter = v.spherePos.z - d.center.z;
		if ( Math.hypot( dxCenter, dzCenter ) > limit ) {
			d.aiState = 'AVOIDANCE';
			d.target.set( d.center.x, 0, d.center.z );
		} else if ( d.aiState !== 'AVOIDANCE' && d.stateTimer <= 0 ) {
			const roll = Math.random();
			if ( roll < 0.45 ) d.aiState = 'DRIFTING';
			else if ( roll < 0.76 ) d.aiState = 'CRUISING';
			else d.aiState = 'DONUT';
			d.stateTimer = d.aiState === 'DONUT' ? 2.2 + Math.random() * 2.2 : 3 + Math.random() * 4;
			const a = Math.random() * Math.PI * 2;
			const r = wander * Math.sqrt( Math.random() );
			d.target.set( d.center.x + Math.cos( a ) * r, 0, d.center.z + Math.sin( a ) * r );
		}

		const input = { x: 0, z: 1, touchActive: false, handbrake: false };
		if ( d.aiState === 'DONUT' ) {
			input.x = 1;
			input.z = 1;
			input.handbrake = Math.sin( performance.now() * 0.012 + drivers.indexOf( d ) ) > 0.15;
		} else {
			const tx = d.aiState === 'AVOIDANCE' ? d.center.x : d.target.x;
			const tz = d.aiState === 'AVOIDANCE' ? d.center.z : d.target.z;
			const targetAngle = Math.atan2( tx - v.spherePos.x, tz - v.spherePos.z );
			const diff = normalizeAngle( targetAngle - headingY( v ) );
			const gain = d.aiState === 'DRIFTING' ? 4 : d.aiState === 'AVOIDANCE' ? 3 : 2;
			input.x = THREE.MathUtils.clamp( - diff * gain, -1, 1 );
			input.z = d.aiState === 'AVOIDANCE' ? 0.72 : d.aiState === 'CRUISING' ? 0.82 : 1;
			input.handbrake = d.aiState === 'DRIFTING' && Math.abs( diff ) > 0.38;
			if ( d.aiState === 'AVOIDANCE' && Math.hypot( dxCenter, dzCenter ) < wander * 0.7 ) {
				d.aiState = 'CRUISING'; d.stateTimer = 2;
			}
		}
		v.update( dt, input );
	}
}
