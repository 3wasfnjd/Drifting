import * as THREE from 'three';
import { rigidBody } from 'crashcat';

const _tmpVec = new THREE.Vector3();
const _tmpScale = new THREE.Vector3();
const _tmpScale2 = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _newZ = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _up = new THREE.Vector3( 0, 1, 0 );

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;
const BASE_SPHERE_RADIUS = 0.5;
const REVERSE_SPEED_SCALE = 1 / 3;
const BODY_SUSPENSION_SINK = 0.1;
const ROAD_RUNNER_MAX_SPEED = MAX_SPEED;

function lerpAngle( a, b, t ) {
	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < - Math.PI ) diff += Math.PI * 2;
	return a + diff * t;
}

function createPivot( node ) {
	const parent = node.parent;
	const pivot = new THREE.Group();
	pivot.name = node.name + '-pivot';
	pivot.rotation.order = 'YXZ';
	pivot.position.copy( node.position );
	parent.add( pivot );
	pivot.add( node );
	node.position.set( 0, 0, 0 );
	return pivot;
}

export class Vehicle {
	constructor() {
		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;
		this.spherePos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.sphereVel = new THREE.Vector3();
		this.sphereRadius = BASE_SPHERE_RADIUS;
		this.visualOffset = BASE_SPHERE_RADIUS;
		this.spawnPos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.spawnAngle = 0;
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
		this.handbrake = false;
		this.driftIntensity = 0;
		this.justLaunched = false;
		this._launchArmed = true;
		this.roadRunnerTime = 0;
		this.roadRunnerRunBlend = 0;
	}

	init( model ) {
		const vehicleModel = model.clone();
		this.container.add( vehicleModel );

		let bodyChild = null;
		const wheelChildren = [];
		vehicleModel.traverse( child => {
			const name = child.name.toLowerCase();
			if ( name === 'body' ) bodyChild = child;
			else if ( name.includes( 'wheel' ) ) wheelChildren.push( child );
			if ( child.isMesh ) {
				child.castShadow = true;
				child.receiveShadow = true;
			}
		} );

		if ( bodyChild ) {
			this.bodyNode = createPivot( bodyChild );
			this._bodyRestY = this.bodyNode.position.y;
			this.bodyNode.getWorldScale( _tmpScale );
			vehicleModel.getWorldScale( _tmpScale2 );
			const extraLocalScale = _tmpScale.y / Math.max( _tmpScale2.y, 0.0001 );
			let clearance = null;
			if ( wheelChildren.length ) {
				vehicleModel.updateMatrixWorld( true );
				const bodyBox = new THREE.Box3().setFromObject( this.bodyNode );
				let lowestWheelY = Infinity;
				const wheelBox = new THREE.Box3();
				for ( const wheelChild of wheelChildren ) {
					wheelBox.setFromObject( wheelChild );
					lowestWheelY = Math.min( lowestWheelY, wheelBox.min.y );
				}
				clearance = bodyBox.min.y - lowestWheelY;
			}
			const targetSink = clearance !== null && clearance > 0 ? clearance * 0.25 : BODY_SUSPENSION_SINK;
			this._bodySuspensionSinkLocal = targetSink / Math.max( extraLocalScale, 0.0001 );
		}

		for ( const child of wheelChildren ) {
			const name = child.name.toLowerCase();
			const pivot = createPivot( child );
			this.wheels.push( pivot );
			if ( name.includes( 'front' ) && name.includes( 'left' ) ) this.wheelFL = pivot;
			if ( name.includes( 'front' ) && name.includes( 'right' ) ) this.wheelFR = pivot;
			if ( name.includes( 'back' ) && name.includes( 'left' ) ) this.wheelBL = pivot;
			if ( name.includes( 'back' ) && name.includes( 'right' ) ) this.wheelBR = pivot;
		}
		return this.container;
	}

	update( dt, controlsInput = {} ) {
		this.inputX = THREE.MathUtils.clamp( controlsInput.x || 0, -1, 1 );
		this.inputZ = THREE.MathUtils.clamp( controlsInput.z || 0, -1, 1 );
		this.handbrake = !! controlsInput.handbrake;

		if ( controlsInput.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {
			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( -3 * dt ) );
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( -cross * 2, -1, 1 );
			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, MAX_SPEED, dt * 1.5 );
		} else {
			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

			const speedAbs = Math.abs( this.linearSpeed );
			const steeringGrip = THREE.MathUtils.clamp( speedAbs, 0.2, 1.0 );
			const speedFactor = THREE.MathUtils.smoothstep( speedAbs, 0.18, 1.05 );
			const hardTurn = THREE.MathUtils.smoothstep( Math.abs( this.inputX ), 0.35, 0.92 );
			const turnMultiplier = this.handbrake ? 4.8 : THREE.MathUtils.lerp( 3.15, 3.65, speedFactor );
			const effectiveGrip = this.handbrake ? THREE.MathUtils.lerp( .62, 1.0, speedFactor ) : steeringGrip;
			const targetAngular = -this.inputX * effectiveGrip * turnMultiplier * direction;
			const steerResponse = this.handbrake ? 5.0 : THREE.MathUtils.lerp( 3.1, 4.0, hardTurn );
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, 1 - Math.exp( -steerResponse * dt ) );
			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ;
			if ( this.linearSpeed < 0.15 && targetSpeed > 0.6 && this._launchArmed ) {
				this.justLaunched = true;
				this._launchArmed = false;
			} else {
				this.justLaunched = false;
			}
			if ( Math.abs( this.linearSpeed ) > 0.5 || targetSpeed < 0.3 ) this._launchArmed = true;

			if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) {
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0.0, dt * 8 );
			} else if ( targetSpeed < 0 ) {
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * MAX_SPEED * REVERSE_SPEED_SCALE, dt * 2 );
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
		if ( this.handbrake ) this.linearSpeed *= Math.max( 0, 1 - 0.55 * dt );

		if ( this.rigidBody ) {
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();
			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const radiusRatio = BASE_SPHERE_RADIUS / Math.max( this.sphereRadius, 0.001 );
			const drive = this.linearSpeed * 100 * dt * radiusRatio;
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [
				angvel[0] + _right.x * drive,
				angvel[1],
				angvel[2] + _right.z * drive
			] );

			const pos = this.rigidBody.position;
			this.spherePos.set( pos[0], pos[1], pos[2] );
			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[0], vel[1], vel[2] );

			// Real drift layer: keep the body's momentum while the nose rotates.
			// Lateral tyre grip is strong in a mild turn, progressively releases in
			// a hard turn, and releases much more with the handbrake. This produces
			// an actual sideways trajectory instead of rotating the model in place.
			const scaleRatio = Math.max( this.sphereRadius / BASE_SPHERE_RADIUS, 0.001 );
			const horizontalSpeed = Math.hypot( this.sphereVel.x, this.sphereVel.z ) / scaleRatio;
			const speedFactor = THREE.MathUtils.smoothstep( horizontalSpeed, 0.18, 1.15 );
			const hardTurn = THREE.MathUtils.smoothstep( Math.abs( this.inputX ), 0.30, 0.90 );
			const forwardVel = this.sphereVel.dot( _forward );
			let lateralVel = this.sphereVel.dot( _right );
			const normalGrip = THREE.MathUtils.lerp( 9.0, 2.4, hardTurn * speedFactor );
			const lateralGrip = this.handbrake ? THREE.MathUtils.lerp( 1.15, 0.38, speedFactor ) : normalGrip;
			lateralVel *= Math.exp( -lateralGrip * dt );

			// A small rear-end breakaway under a hard steer makes initiation feel
			// like a car losing rear grip rather than a perfectly circular turn.
			const breakaway = ( this.handbrake ? 0.72 : 0.24 ) * hardTurn * speedFactor * Math.abs( forwardVel );
			lateralVel += -Math.sign( this.inputX || 0 ) * breakaway * dt;

			const correctedX = _forward.x * forwardVel + _right.x * lateralVel;
			const correctedZ = _forward.z * forwardVel + _right.z * lateralVel;
			rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [ correctedX, vel[1], correctedZ ] );
			this.sphereVel.set( correctedX, vel[1], correctedZ );
		}

		this.acceleration = THREE.MathUtils.lerp(
			this.acceleration,
			this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ),
			dt
		);

		const respawnDropDistance = Math.max( 2.0 * ( this.sphereRadius / BASE_SPHERE_RADIUS ), 0.05 );
		const respawnYLimit = this.spawnPos.y - respawnDropDistance;
		if ( this.spherePos.y < respawnYLimit ) {
			if ( this.rigidBody ) {
				rigidBody.setPosition( this.physicsWorld, this.rigidBody, this.spawnPos.toArray(), false );
				rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [0,0,0] );
				rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [0,0,0] );
			}
			this.spherePos.copy( this.spawnPos );
			this.sphereVel.set( 0,0,0 );
			this.linearSpeed = 0;
			this.angularSpeed = 0;
			this.acceleration = 0;
			this.container.quaternion.setFromAxisAngle( _up, this.spawnAngle );
		}

		this.container.position.set(
			this.spherePos.x,
			this.spherePos.y - this.sphereRadius,
			this.spherePos.z
		);

		if ( dt > 0 ) {
			this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt );
			this.prevModelPos.copy( this.container.position );
		}

		this.updateBody( dt );
		this.updateWheels( dt );
		this.updateRoadRunner( dt );

		_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
		_forward.y = 0;
		_forward.normalize();
		_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
		_right.y = 0;
		_right.normalize();
		const scaleRatio = Math.max( this.sphereRadius / BASE_SPHERE_RADIUS, 0.001 );
		const lateralSlip = Math.abs( this.sphereVel.dot( _right ) ) / scaleRatio;
		this.driftIntensity = lateralSlip * 1.45 +
			Math.abs( this.linearSpeed - this.acceleration ) +
			( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 1.35 : 0 ) +
			( this.handbrake ? 0.55 : 0 );
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
		this.bodyNode.position.y = THREE.MathUtils.lerp(
			this.bodyNode.position.y,
			this._bodyRestY - this._bodySuspensionSinkLocal,
			dt * 5
		);
	}

	updateWheels( dt ) {
		for ( const wheel of this.wheels ) wheel.rotation.x += this.acceleration;
		if ( this.wheelFL ) this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, -this.inputX / 1.5, dt * 10 );
		if ( this.wheelFR ) this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, -this.inputX / 1.5, dt * 10 );
	}

	updateRoadRunner( dt ) {
		const r = this.container.getObjectByName( 'road-runner-free-ar' );
		if ( ! r || ! r.visible ) return;
		const bt = r.getObjectByName( 'Object_2' );
		const legs = r.getObjectByName( 'Object_3' );
		const head = r.getObjectByName( 'Object_5' );
		const speed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / ROAD_RUNNER_MAX_SPEED, 0, 1 );
		this.roadRunnerRunBlend = THREE.MathUtils.lerp( this.roadRunnerRunBlend, THREE.MathUtils.smoothstep( speed, .07, .4 ), 1 - Math.exp( -dt * 6.5 ) );
		this.roadRunnerTime += dt * ( 5 + speed * 30 );
		const run = this.roadRunnerRunBlend;
		if ( legs ) {
			if ( ! legs.userData.rrBase ) legs.userData.rrBase = { p: legs.position.clone(), s: legs.scale.clone() };
			const b = legs.userData.rrBase;
			legs.position.copy( b.p );
			legs.position.y += Math.sin( this.roadRunnerTime * 2 ) * .012 * run;
			legs.scale.copy( b.s ).multiplyScalar( 1 - run * .18 );
		}
		if ( bt ) {
			if ( ! bt.userData.rrBaseRot ) bt.userData.rrBaseRot = bt.rotation.clone();
			bt.rotation.x = bt.userData.rrBaseRot.x + Math.sin( this.roadRunnerTime ) * .045 * run;
			bt.rotation.z = bt.userData.rrBaseRot.z - this.inputX * speed * .12;
		}
		if ( head ) {
			if ( ! head.userData.rrBaseRot ) head.userData.rrBaseRot = head.rotation.clone();
			head.rotation.z = head.userData.rrBaseRot.z + this.inputX * speed * .10;
		}
	}
}
