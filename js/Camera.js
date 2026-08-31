import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();
const _introFollowPos = new THREE.Vector3();

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 40, window.innerWidth / window.innerHeight, 0.1, 180 );

		// Matches Godot View: 45° azimuth, 35° elevation, distance 16
		this.offset = new THREE.Vector3( 9.27, 9.18, 9.27 );

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		// Camera-aligned ground basis (XZ plane), derived from offset.
		this.camRightXZ = new THREE.Vector3( this.offset.z, 0, - this.offset.x ).normalize();
		this.camForwardXZ = new THREE.Vector3( - this.offset.x, 0, - this.offset.z ).normalize();

		this.leadFactor = 3.0;
		this.cameraSmoothing = 2.0;
		this.deadzoneRadius = 5.0;
		this.screenShiftUp = 1.0;

		this.smoothedDesired = new THREE.Vector3();
		this.initialized = false;

		// Web arena cinematic entrance: show the complete 40-radius arena first,
		// then smoothly move into the normal chase camera.
		const params = new URLSearchParams( window.location.search );
		this.arenaIntro = params.get( 'mode' ) === 'arena' && params.get( 'ar' ) !== '1';
		this.arenaIntroTime = 0;
		this.arenaIntroHold = 1.35;
		this.arenaIntroBlend = 1.65;
		this.arenaOverviewPosition = new THREE.Vector3( 0, 92, 58 );

		const segments = 64;
		const points = [];
		for ( let i = 0; i <= segments; i ++ ) {

			const a = ( i / segments ) * Math.PI * 2;
			points.push( new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ) );

		}
		const dzGeom = new THREE.BufferGeometry().setFromPoints( points );
		this.debug = new THREE.Line( dzGeom, new THREE.LineBasicMaterial( { color: 0xff00ff, depthTest: false } ) );
		this.debug.visible = false;
		this.debug.renderOrder = 999;
		this.debug.quaternion.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis( this.camRightXZ, new THREE.Vector3( 0, 1, 0 ), this.camForwardXZ )
		);

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	update( dt, target, velocity ) {

		const radius = this.deadzoneRadius;
		const radiusSq = radius * radius;

		let leadX = velocity.dot( this.camRightXZ ) * this.leadFactor;
		let leadY = velocity.dot( this.camForwardXZ ) * this.leadFactor;
		const leadLenSq = leadX * leadX + leadY * leadY;
		if ( leadLenSq > radiusSq ) {

			const k = radius / Math.sqrt( leadLenSq );
			leadX *= k;
			leadY *= k;

		}

		_desired.copy( target )
			.addScaledVector( this.camRightXZ, leadX )
			.addScaledVector( this.camForwardXZ, leadY );

		const alpha = this.initialized ? 1 - Math.exp( - dt * this.cameraSmoothing ) : 1;
		this.smoothedDesired.lerp( _desired, alpha );
		this.initialized = true;

		_delta.subVectors( target, this.smoothedDesired );
		const offsetX = _delta.dot( this.camRightXZ );
		const offsetY = _delta.dot( this.camForwardXZ );
		const offsetLenSq = offsetX * offsetX + offsetY * offsetY;
		if ( offsetLenSq > radiusSq ) {

			const offsetLen = Math.sqrt( offsetLenSq );
			const k = ( offsetLen - radius ) / offsetLen;
			this.smoothedDesired
				.addScaledVector( this.camRightXZ, offsetX * k )
				.addScaledVector( this.camForwardXZ, offsetY * k );

		}

		_lookPoint.copy( this.smoothedDesired ).addScaledVector( this.camForwardXZ, - this.screenShiftUp );
		_introFollowPos.copy( _lookPoint ).add( this.offset );

		if ( this.arenaIntro ) {

			this.arenaIntroTime += dt;
			const blendStart = this.arenaIntroHold;
			const blendEnd = blendStart + this.arenaIntroBlend;

			if ( this.arenaIntroTime < blendStart ) {

				this.camera.position.copy( this.arenaOverviewPosition );
				this.camera.lookAt( 0, 0, 0 );

			} else if ( this.arenaIntroTime < blendEnd ) {

				let t = ( this.arenaIntroTime - blendStart ) / this.arenaIntroBlend;
				t = t * t * ( 3 - 2 * t );
				this.camera.position.lerpVectors( this.arenaOverviewPosition, _introFollowPos, t );
				const introLook = _desired.set( 0, 0, 0 ).lerp( _lookPoint, t );
				this.camera.lookAt( introLook );

			} else {

				this.arenaIntro = false;
				this.camera.position.copy( _introFollowPos );
				this.camera.lookAt( _lookPoint );

			}

		} else {

			this.camera.position.copy( _introFollowPos );
			this.camera.lookAt( _lookPoint );

		}

		this.debug.position.copy( this.smoothedDesired );
		this.debug.position.y += 0.05;
		this.debug.scale.set( radius, 1, radius );

	}

}
