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

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 1.5;
const ROAD_RUNNER_MAX_SPEED = 5.0;
const ROAD_RUNNER_ACCELERATION = 10.0;

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
		this.roadRunnerTime = 0;
		this.roadRunnerRunBlend = 0;
	}

	init( model ) {
		const vehicleModel = model.clone();
		this.container.add( vehicleModel );
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

		const roadRunner = this.container.getObjectByName( 'road-runner-free-ar' );
		const roadRunnerActive = !! ( roadRunner && roadRunner.visible );
		const maxSpeed = roadRunnerActive ? ROAD_RUNNER_MAX_SPEED : MAX_SPEED;
		const accelerationRate = roadRunnerActive ? ROAD_RUNNER_ACCELERATION : 1.5;

		if ( controlsInput.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {
			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - 3 * dt ) );
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( - cross * 2, - 1, 1 );
			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, maxSpeed, Math.min( 1, dt * accelerationRate ) );
		} else {
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
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed * 0.35, dt * 3 );
			} else {
				const rate = roadRunnerActive && targetSpeed > 0.1 ? accelerationRate : 1.5;
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed, Math.min( 1, dt * rate ) );
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
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ angvel[ 0 ] + _right.x * drive, angvel[ 1 ], angvel[ 2 ] + _right.z * drive ] );
			const pos = this.rigidBody.position;
			this.spherePos.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[ 0 ], vel[ 1 ], vel[ 2 ] );
		}

		this.acceleration = THREE.MathUtils.lerp( this.acceleration, this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ), dt );
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

		this.container.position.set( this.spherePos.x, this.spherePos.y - this.visualOffset, this.spherePos.z );
		if ( dt > 0 ) {
			this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt );
			this.prevModelPos.copy( this.container.position );
		}
		this.updateBody( dt );
		this.updateWheels( dt );
		this.updateRoadRunner( dt );
		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) + ( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 2 : 0 );
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
		this.bodyNode.rotation.x = lerpAngle( this.bodyNode.rotation.x, -( this.linearSpeed - this.acceleration ) / 6, dt * 10 );
		this.bodyNode.rotation.z = lerpAngle( this.bodyNode.rotation.z, -( this.inputX / 5 ) * this.linearSpeed, dt * 5 );
		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, 0.3, dt * 5 );
	}

	updateWheels( dt ) {
		for ( const wheel of this.wheels ) wheel.rotation.x += this.acceleration;
		if ( this.wheelFL ) this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, -this.inputX / 1.5, dt * 10 );
		if ( this.wheelFR ) this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, -this.inputX / 1.5, dt * 10 );
	}

	updateRoadRunner( dt ) {
		const roadRunner = this.container.getObjectByName( 'road-runner-free-ar' );
		if ( ! roadRunner || ! roadRunner.visible ) return;
		const bodyTail = roadRunner.getObjectByName( 'Object_2' );
		const legs = roadRunner.getObjectByName( 'Object_3' );
		const eyes = roadRunner.getObjectByName( 'Object_4' );
		const head = roadRunner.getObjectByName( 'Object_5' );
		for ( const node of [ bodyTail, legs, eyes, head ] ) {
			if ( ! node || node.userData.roadRunnerBase ) continue;
			node.userData.roadRunnerBase = { position: node.position.clone(), rotation: node.rotation.clone(), scale: node.scale.clone() };
		}

		const speed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / ROAD_RUNNER_MAX_SPEED, 0, 1 );
		const legCycleTarget = THREE.MathUtils.smoothstep( speed, 0.07, 0.40 );
		const speedRingTarget = THREE.MathUtils.smoothstep( speed, 0.45, 0.82 );
		this.roadRunnerRunBlend = THREE.MathUtils.lerp( this.roadRunnerRunBlend, legCycleTarget, 1 - Math.exp( - dt * 6.5 ) );
		const runBlend = this.roadRunnerRunBlend;
		const speedBlend = THREE.MathUtils.clamp( speedRingTarget * runBlend, 0, 1 );
		this.roadRunnerTime += dt * ( 4 + speed * 36 );

		const accelDelta = THREE.MathUtils.clamp( this.linearSpeed - this.acceleration, -0.7, 0.7 );
		const rubber = accelDelta * 0.11;
		const bounce = Math.sin( this.roadRunnerTime * 0.55 ) * 0.018 * speed;
		roadRunner.scale.x = 2.2 * ( 1 - Math.abs( rubber ) * 0.35 );
		roadRunner.scale.y = 2.2 * ( 1 - rubber * 0.32 + bounce );
		roadRunner.scale.z = 2.2 * ( 1 + rubber * 0.75 );

		let runRing = roadRunner.getObjectByName( 'road-runner-run-ring' );
		if ( ! runRing && legs ) {
			runRing = new THREE.Group();
			runRing.name = 'road-runner-run-ring';
			const legBox = new THREE.Box3().setFromObject( legs );
			const legSize = legBox.getSize( new THREE.Vector3() );
			const radius = Math.max( 0.18, Math.max( legSize.y, legSize.z ) * 0.55 );
			const tube = Math.max( 0.016, radius * 0.055 );
			const makeLoop = ( size, material, tubeScale = 1 ) => {
				const r = radius * size;
				const curve = new THREE.CatmullRomCurve3( [
					new THREE.Vector3( 0, 0.50 * r, -1.16 * r ),
					new THREE.Vector3( 0, 0.76 * r, -0.48 * r ),
					new THREE.Vector3( 0, 0.72 * r, 0.42 * r ),
					new THREE.Vector3( 0, 0.42 * r, 1.08 * r ),
					new THREE.Vector3( 0, -0.18 * r, 1.20 * r ),
					new THREE.Vector3( 0, -0.54 * r, 0.48 * r ),
					new THREE.Vector3( 0, -0.46 * r, -0.56 * r ),
					new THREE.Vector3( 0, -0.02 * r, -1.18 * r )
				], true, 'centripetal' );
				return new THREE.Mesh( new THREE.TubeGeometry( curve, 64, tube * tubeScale, 6, true ), material );
			};
			const legMaterial = new THREE.MeshStandardMaterial( { color: 0xb05b24, roughness: 0.72, metalness: 0, transparent: true, opacity: 0 } );
			const speedMaterial = new THREE.MeshBasicMaterial( { color: 0xc77837, transparent: true, opacity: 0, depthWrite: false } );
			const legGroup = new THREE.Group();
			legGroup.name = 'road-runner-leg-cycle';
			for ( let i = 0; i < 4; i ++ ) {
				const loop = makeLoop( 0.88 + i * 0.045, legMaterial.clone(), 1 - i * 0.06 );
				loop.position.x = ( i - 1.5 ) * tube * 0.7;
				legGroup.add( loop );
			}
			const speedGroup = new THREE.Group();
			speedGroup.name = 'road-runner-speed-cycle';
			for ( let i = 0; i < 5; i ++ ) {
				const loop = makeLoop( 0.98 + i * 0.035, speedMaterial.clone(), 0.52 );
				loop.position.x = ( i - 2 ) * tube * 0.55;
				speedGroup.add( loop );
			}
			runRing.add( legGroup, speedGroup );
			runRing.position.copy( legs.position );
			roadRunner.add( runRing );
		}
		if ( runRing ) {
			const legGroup = runRing.getObjectByName( 'road-runner-leg-cycle' );
			const speedGroup = runRing.getObjectByName( 'road-runner-speed-cycle' );
			runRing.visible = runBlend > 0.01;
			runRing.rotation.set( 0, 0, 0 );
			const pulse = 1 + Math.sin( this.roadRunnerTime * 2.2 ) * 0.025 * runBlend;
			runRing.scale.set( 0.70 + runBlend * 0.36, ( 0.74 + runBlend * 0.28 ) * pulse, 0.92 + speedBlend * 0.13 );
			if ( legGroup ) {
				const opacity = runBlend * ( 1 - speedBlend * 0.50 ) * 0.92;
				legGroup.position.y = Math.sin( this.roadRunnerTime * 2.6 ) * 0.008 * runBlend;
				for ( const child of legGroup.children ) child.material.opacity = opacity;
			}
			if ( speedGroup ) {
				const opacity = speedBlend * 0.82;
				speedGroup.scale.setScalar( 1 + Math.sin( this.roadRunnerTime * 4.5 ) * 0.018 * speedBlend );
				for ( const child of speedGroup.children ) child.material.opacity = opacity;
			}
		}

		if ( legs?.userData.roadRunnerBase ) {
			const base = legs.userData.roadRunnerBase;
			const feetFade = THREE.MathUtils.smoothstep( runBlend, 0.05, 0.72 );
			legs.position.copy( base.position );
			legs.rotation.copy( base.rotation );
			legs.scale.copy( base.scale ).multiplyScalar( Math.max( 0.04, 1 - feetFade * 0.96 ) );
			legs.position.y = base.position.y + feetFade * 0.018;
		}

		if ( bodyTail?.userData.roadRunnerBase ) {
			const base = bodyTail.userData.roadRunnerBase;
			const flutter = Math.sin( this.roadRunnerTime * 1.25 ) * ( 0.012 + speed * 0.045 );
			bodyTail.rotation.x = lerpAngle( bodyTail.rotation.x, base.rotation.x - accelDelta * 0.20 + flutter, Math.min( 1, dt * 7 ) );
			bodyTail.rotation.z = lerpAngle( bodyTail.rotation.z, base.rotation.z - this.inputX * speed * 0.16 + flutter * 0.5, Math.min( 1, dt * 7 ) );
			bodyTail.position.z = THREE.MathUtils.lerp( bodyTail.position.z, base.position.z - accelDelta * 0.07, Math.min( 1, dt * 6 ) );
		}
		if ( head?.userData.roadRunnerBase ) {
			const base = head.userData.roadRunnerBase;
			head.rotation.x = lerpAngle( head.rotation.x, base.rotation.x - accelDelta * 0.13 + Math.sin( this.roadRunnerTime * 0.5 ) * 0.018, Math.min( 1, dt * 8 ) );
			head.rotation.z = lerpAngle( head.rotation.z, base.rotation.z + this.inputX * speed * 0.15, Math.min( 1, dt * 8 ) );
			head.position.y = THREE.MathUtils.lerp( head.position.y, base.position.y + Math.sin( this.roadRunnerTime * 0.65 ) * ( 0.006 + speed * 0.014 ), Math.min( 1, dt * 8 ) );
		}

		// Eye animation disabled: keep the original eye transform fixed.
		if ( eyes?.userData.roadRunnerBase ) {
			const base = eyes.userData.roadRunnerBase;
			eyes.position.copy( base.position );
			eyes.rotation.copy( base.rotation );
			eyes.scale.copy( base.scale );
		}
	}
}
