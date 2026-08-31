import * as THREE from 'three';
import { rigidBody } from 'crashcat';

const _tmpVec = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _newZ = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3( 0, 1, 0 );

const SPEED_SCALE = 12.5;
const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;

function lerpAngle( a, b, t ) {

	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < -Math.PI ) diff += Math.PI * 2;
	return a + diff * t;

}

export class Vehicle {

	constructor() {

		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;

		// AR placement compatibility; driving physics below remains upstream.
		this.spawnPos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.spawnAngle = 0;
		this.visualOffset = 0.5;

		this.spherePos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.sphereVel = new THREE.Vector3();

		this.rigidBody = null;
		this.physicsWorld = null;

		this.modelVelocity = new THREE.Vector3();
		this.prevModelPos = new THREE.Vector3( 3.5, 0, 5 );

		this.container = new THREE.Group();
		this.bodyNode = null;
		this.wheels = [];
		this.wheelFL = null;
		this.wheelFR = null;
		this.wheelBL = null;
		this.wheelBR = null;

		this.inputX = 0;
		this.inputZ = 0;

		this.driftIntensity = 0;

		// Procedural animation state for the Road Runner visual used in free AR.
		this.roadRunnerTime = 0;
		this.roadRunnerBlinkTimer = 1.5 + Math.random() * 2.5;
		this.roadRunnerBlinkTime = 0;

	}

	init( model ) {

		const vehicleModel = model.clone();

		this.container.add( vehicleModel );

		// Find body and wheel nodes
		vehicleModel.traverse( ( child ) => {

			const name = child.name.toLowerCase();

			if ( name === 'body' ) {

				child.rotation.order = 'YXZ';
				this.bodyNode = child;

			} else if ( name.includes( 'wheel' ) ) {

				child.rotation.order = 'YXZ';
				this.wheels.push( child );

				if ( name.includes( 'front' ) && name.includes( 'left' ) ) this.wheelFL = child;
				if ( name.includes( 'front' ) && name.includes( 'right' ) ) this.wheelFR = child;
				if ( name.includes( 'back' ) && name.includes( 'left' ) ) this.wheelBL = child;
				if ( name.includes( 'back' ) && name.includes( 'right' ) ) this.wheelBR = child;

			}

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;

			}

		} );

		return this.container;

	}

	update( dt, controlsInput ) {

		this.inputX = controlsInput.x;
		this.inputZ = controlsInput.z;

		if ( controlsInput.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {

			// Touch: joystick defines world-space direction, auto-gas
			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - 3 * dt ) );

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( - cross * 2, - 1, 1 );

			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, MAX_SPEED, dt * 1.5 );

		} else {

			// Keyboard / gamepad: standard steering + throttle
			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

			const steeringGrip = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ), 0.2, 1.0 );

			const targetAngular = - this.inputX * steeringGrip * 4 * direction;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, dt * 4 );

			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ;

			if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) {

				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0.0, dt * 8 );

			} else if ( targetSpeed < 0 ) {

				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed / 2, dt * 2 );

			} else {

				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * MAX_SPEED, dt * 1.5 );

			}

		}

		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );

		if ( _tmpVec.y > 0.5 ) {

			const targetQuat = this.alignWithY( this.container.quaternion, _up );
			this.container.quaternion.slerp( targetQuat, 0.2 );

		}

		this.linearSpeed *= Math.max( 0, 1 - LINEAR_DAMP * dt );

		if ( this.rigidBody ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const drive = this.linearSpeed * 100 * dt;

			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [
				angvel[ 0 ] + _right.x * drive,
				angvel[ 1 ],
				angvel[ 2 ] + _right.z * drive
			] );

			const pos = this.rigidBody.position;
			this.spherePos.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );

			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[ 0 ], vel[ 1 ], vel[ 2 ] );

		}

		this.acceleration = THREE.MathUtils.lerp(
			this.acceleration,
			this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ),
			dt
		);

		if ( this.spherePos.y < - 10 ) {

			if ( this.rigidBody ) {

				rigidBody.setPosition( this.physicsWorld, this.rigidBody, this.spawnPos.toArray(), false );
				rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );
				rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );

			}

			this.spherePos.copy( this.spawnPos );
			this.sphereVel.set( 0, 0, 0 );
			this.linearSpeed = 0;
			this.angularSpeed = 0;
			this.acceleration = 0;
			this.container.quaternion.setFromAxisAngle( _up, this.spawnAngle );

		}

		this.container.position.set(
			this.spherePos.x,
			this.spherePos.y - this.visualOffset,
			this.spherePos.z
		);

		if ( dt > 0 ) {

			this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt );
			this.prevModelPos.copy( this.container.position );

		}

		this.updateBody( dt );
		this.updateWheels( dt );
		this.updateRoadRunner( dt );

		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) +
			( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 2 : 0 );

	}

	alignWithY( quaternion, newY ) {

		_zAxis.set( 0, 0, 1 ).applyQuaternion( quaternion );
		const xAxis = _tmpVec.crossVectors( _zAxis, newY ).negate().normalize();
		_newZ.crossVectors( xAxis, newY ).normalize();

		_mat4.makeBasis( xAxis, newY, _newZ );
		return _quat.setFromRotationMatrix( _mat4 );

	}

	updateBody( dt ) {

		if ( ! this.bodyNode ) return;

		this.bodyNode.rotation.x = lerpAngle(
			this.bodyNode.rotation.x,
			-( this.linearSpeed - this.acceleration ) / 6,
			dt * 10
		);

		this.bodyNode.rotation.z = lerpAngle(
			this.bodyNode.rotation.z,
			-( this.inputX / 5 ) * this.linearSpeed,
			dt * 5
		);

		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, 0.3, dt * 5 );

	}

	updateWheels( dt ) {

		for ( const wheel of this.wheels ) {

			wheel.rotation.x += this.acceleration;

		}

		if ( this.wheelFL ) {

			this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, -this.inputX / 1.5, dt * 10 );

		}

		if ( this.wheelFR ) {

			this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, -this.inputX / 1.5, dt * 10 );

		}

	}

	updateRoadRunner( dt ) {

		const roadRunner = this.container.getObjectByName( 'road-runner-free-ar' );
		if ( ! roadRunner || ! roadRunner.visible ) return;

		// Enlarge only the Road Runner visual in free AR so facial and leg details are easier to inspect.
		roadRunner.scale.setScalar( 1.1 );

		const bodyTail = roadRunner.getObjectByName( 'Object_2' );
		const legs = roadRunner.getObjectByName( 'Object_3' );
		const eyes = roadRunner.getObjectByName( 'Object_4' );
		const head = roadRunner.getObjectByName( 'Object_5' );

		for ( const node of [ bodyTail, legs, eyes, head ] ) {

			if ( ! node || node.userData.roadRunnerBase ) continue;
			node.userData.roadRunnerBase = {
				position: node.position.clone(),
				rotation: node.rotation.clone(),
				scale: node.scale.clone(),
			};

		}

		const speed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / MAX_SPEED, 0, 1 );
		const signedSpeed = Math.sign( this.linearSpeed || 1 );
		const runRate = 4 + speed * 24;
		this.roadRunnerTime += dt * runRate;

		// Lower body/feet: slow stepping becomes a very fast cartoon wheel-like cycle.
		if ( legs?.userData.roadRunnerBase ) {

			const base = legs.userData.roadRunnerBase;
			const stride = Math.sin( this.roadRunnerTime * 2 ) * ( 0.08 + speed * 0.34 );
			legs.rotation.x = base.rotation.x + stride * signedSpeed;
			legs.rotation.z = base.rotation.z + Math.sin( this.roadRunnerTime * 4 ) * speed * 0.08;
			legs.position.y = base.position.y + Math.abs( Math.sin( this.roadRunnerTime * 2 ) ) * speed * 0.025;

		}

		// Body/tail gets a small speed flutter and leans into steering.
		if ( bodyTail?.userData.roadRunnerBase ) {

			const base = bodyTail.userData.roadRunnerBase;
			bodyTail.rotation.z = base.rotation.z - this.inputX * speed * 0.10 + Math.sin( this.roadRunnerTime ) * speed * 0.025;
			bodyTail.rotation.x = base.rotation.x + Math.sin( this.roadRunnerTime * 1.5 ) * speed * 0.018;

		}

		// Head/crest follows acceleration and counter-leans during steering/drift.
		if ( head?.userData.roadRunnerBase ) {

			const base = head.userData.roadRunnerBase;
			const accelLean = THREE.MathUtils.clamp( ( this.linearSpeed - this.acceleration ) * 0.18, -0.12, 0.12 );
			head.rotation.x = base.rotation.x - accelLean + Math.sin( this.roadRunnerTime * 0.65 ) * 0.018;
			head.rotation.z = base.rotation.z + this.inputX * speed * 0.13;
			head.position.y = base.position.y + Math.sin( this.roadRunnerTime * 0.7 ) * ( 0.006 + speed * 0.012 );

		}

		// Natural irregular blink. The eyes are a separate mesh, so squash them vertically.
		if ( eyes?.userData.roadRunnerBase ) {

			const base = eyes.userData.roadRunnerBase;
			this.roadRunnerBlinkTimer -= dt;
			if ( this.roadRunnerBlinkTimer <= 0 && this.roadRunnerBlinkTime <= 0 ) {
				this.roadRunnerBlinkTime = 0.13;
				this.roadRunnerBlinkTimer = 1.7 + Math.random() * 3.3;
			}

			if ( this.roadRunnerBlinkTime > 0 ) this.roadRunnerBlinkTime -= dt;
			const blinkProgress = this.roadRunnerBlinkTime > 0 ? 1 - this.roadRunnerBlinkTime / 0.13 : 0;
			const blink = this.roadRunnerBlinkTime > 0 ? Math.sin( blinkProgress * Math.PI ) : 0;
			const targetScaleY = base.scale.y * ( 1 - blink * 0.92 );
			eyes.scale.y = THREE.MathUtils.lerp( eyes.scale.y, targetScaleY, Math.min( 1, dt * 35 ) );

		}

	}

}
