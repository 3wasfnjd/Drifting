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
const _rrDeltaQuat = new THREE.Quaternion();
const _rrBaseHeadQuat = new THREE.Quaternion();
const _rrEyeQuat = new THREE.Quaternion();
const _rrEyeOffset = new THREE.Vector3();

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 2.4;
const VEHICLE_ACCELERATION = 2.6;
const ROAD_RUNNER_MAX_SPEED = 5.0;
const ROAD_RUNNER_ACCELERATION = 10.0;
const REVERSE_SPEED_SCALE = 0.6;

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
		this.sphereRadius = 0.5;
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
		this.handbrake = false;
		this.driftIntensity = 0;
		this.roadRunnerTime = 0;
		this.roadRunnerRunBlend = 0;
	}

	init( model ) {
		const vehicleModel = model.clone();
		this.container.add( vehicleModel );
		vehicleModel.traverse( child => {
			const name = child.name.toLowerCase();
			if ( name === 'body' ) { child.rotation.order = 'YXZ'; this.bodyNode = child; }
			else if ( name.includes( 'wheel' ) ) {
				child.rotation.order = 'YXZ'; this.wheels.push( child );
				if ( name.includes( 'front' ) && name.includes( 'left' ) ) this.wheelFL = child;
				if ( name.includes( 'front' ) && name.includes( 'right' ) ) this.wheelFR = child;
				if ( name.includes( 'back' ) && name.includes( 'left' ) ) this.wheelBL = child;
				if ( name.includes( 'back' ) && name.includes( 'right' ) ) this.wheelBR = child;
			}
			if ( child.isMesh ) { child.castShadow = true; child.receiveShadow = true; }
		} );
		return this.container;
	}

	update( dt, controlsInput ) {
		this.inputX = controlsInput.x || 0;
		this.inputZ = controlsInput.z || 0;
		this.handbrake = !! controlsInput.handbrake;
		const roadRunner = this.container.getObjectByName( 'road-runner-free-ar' );
		const roadRunnerActive = !! ( roadRunner && roadRunner.visible );
		const maxSpeed = roadRunnerActive ? ROAD_RUNNER_MAX_SPEED : MAX_SPEED;
		const accelerationRate = roadRunnerActive ? ROAD_RUNNER_ACCELERATION : VEHICLE_ACCELERATION;

		if ( controlsInput.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {
			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - ( this.handbrake ? 5 : 3 ) * dt ) );
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( - cross * 2, -1, 1 );
			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, maxSpeed, Math.min( 1, dt * accelerationRate ) );
		} else {
			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;
			const steeringGrip = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ), 0.2, 1 );
			const effectiveGrip = this.handbrake ? 1 : steeringGrip;
			const turnMultiplier = this.handbrake ? 6.5 : 4;
			const targetAngular = - this.inputX * effectiveGrip * turnMultiplier * direction;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, Math.min( 1, dt * ( this.handbrake ? 7 : 4 ) ) );
			this.container.rotateY( this.angularSpeed * dt );
			const targetSpeed = this.inputZ;
			if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0, Math.min( 1, dt * 8 ) );
			else if ( targetSpeed < 0 ) this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed * REVERSE_SPEED_SCALE, Math.min( 1, dt * 2.5 ) );
			else this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed, Math.min( 1, dt * accelerationRate ) );
		}

		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );
		if ( _tmpVec.y > 0.5 ) this.container.quaternion.slerp( this.alignWithY( this.container.quaternion, _up ), 0.2 );
		this.linearSpeed *= Math.max( 0, 1 - LINEAR_DAMP * dt );
		if ( this.handbrake ) this.linearSpeed *= Math.max( 0, 1 - 1.2 * dt );

		if ( this.rigidBody ) {
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion ); _forward.y = 0; _forward.normalize();
			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion ); _right.y = 0; _right.normalize();
			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const radiusRatio = 0.5 / Math.max( this.sphereRadius || this.visualOffset || 0.5, 0.001 );
			const drive = this.linearSpeed * 100 * dt * radiusRatio;
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ angvel[0] + _right.x * drive, angvel[1], angvel[2] + _right.z * drive ] );
			const pos = this.rigidBody.position; this.spherePos.set( pos[0], pos[1], pos[2] );
			const vel = this.rigidBody.motionProperties.linearVelocity; this.sphereVel.set( vel[0], vel[1], vel[2] );
		}

		this.acceleration = THREE.MathUtils.lerp( this.acceleration, this.linearSpeed + 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ), dt );
		const respawnDrop = Math.max( 2 * ( ( this.sphereRadius || 0.5 ) / 0.5 ), 0.05 );
		if ( this.spherePos.y < this.spawnPos.y - respawnDrop ) {
			if ( this.rigidBody ) {
				rigidBody.setPosition( this.physicsWorld, this.rigidBody, this.spawnPos.toArray(), false );
				rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [0,0,0] );
				rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [0,0,0] );
			}
			this.spherePos.copy( this.spawnPos ); this.sphereVel.set(0,0,0); this.linearSpeed = 0; this.angularSpeed = 0; this.acceleration = 0;
			this.container.quaternion.setFromAxisAngle( _up, this.spawnAngle );
		}

		this.container.position.set( this.spherePos.x, this.spherePos.y - this.visualOffset, this.spherePos.z );
		if ( dt > 0 ) { this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt ); this.prevModelPos.copy( this.container.position ); }
		this.updateBody( dt );
		this.updateWheels( dt );
		this.updateRoadRunner( dt );
		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) + ( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 2 : 0 ) + ( this.handbrake ? 0.7 : 0 ) + Math.abs( this.inputX ) * Math.abs( this.linearSpeed ) * 0.6;
	}

	alignWithY( quaternion, newY ) {
		_zAxis.set( 0, 0, 1 ).applyQuaternion( quaternion );
		const xAxis = _tmpVec.crossVectors( _zAxis, newY ).negate().normalize(); _newZ.crossVectors( xAxis, newY ).normalize();
		_mat4.makeBasis( xAxis, newY, _newZ ); return _quat.setFromRotationMatrix( _mat4 );
	}
	updateBody( dt ) {
		if ( ! this.bodyNode ) return;
		this.bodyNode.rotation.x = lerpAngle( this.bodyNode.rotation.x, -( this.linearSpeed - this.acceleration ) / 6, dt * 10 );
		this.bodyNode.rotation.z = lerpAngle( this.bodyNode.rotation.z, -( this.inputX / 5 ) * this.linearSpeed, dt * 5 );
		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, 0.3, dt * 5 );
	}
	updateWheels() {
		for ( const wheel of this.wheels ) wheel.rotation.x += this.acceleration;
		if ( this.wheelFL ) this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, -this.inputX / 1.5, 0.35 );
		if ( this.wheelFR ) this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, -this.inputX / 1.5, 0.35 );
	}

	updateRoadRunner( dt ) {
		const roadRunner = this.container.getObjectByName( 'road-runner-free-ar' );
		if ( ! roadRunner || ! roadRunner.visible ) return;
		const bodyTail = roadRunner.getObjectByName( 'Object_2' );
		const legs = roadRunner.getObjectByName( 'Object_3' );
		const eyes = roadRunner.getObjectByName( 'Object_4' );
		const head = roadRunner.getObjectByName( 'Object_5' );
		for ( const node of [ bodyTail, legs, eyes, head ] ) if ( node && ! node.userData.roadRunnerBase ) node.userData.roadRunnerBase = { position: node.position.clone(), rotation: node.rotation.clone(), scale: node.scale.clone() };
		const speed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / ROAD_RUNNER_MAX_SPEED, 0, 1 );
		const legCycleTarget = THREE.MathUtils.smoothstep( speed, 0.07, 0.40 );
		const speedRingTarget = THREE.MathUtils.smoothstep( speed, 0.45, 0.82 );
		this.roadRunnerRunBlend = THREE.MathUtils.lerp( this.roadRunnerRunBlend, legCycleTarget, 1 - Math.exp( -dt * 6.5 ) );
		const runBlend = this.roadRunnerRunBlend, speedBlend = THREE.MathUtils.clamp( speedRingTarget * runBlend, 0, 1 );
		this.roadRunnerTime += dt * ( 4 + speed * 36 );
		const accelDelta = THREE.MathUtils.clamp( this.linearSpeed - this.acceleration, -0.7, 0.7 );
		const rubber = accelDelta * 0.11, bounce = Math.sin( this.roadRunnerTime * 0.55 ) * 0.018 * speed;
		roadRunner.scale.x = 2.2 * ( 1 - Math.abs( rubber ) * 0.35 ); roadRunner.scale.y = 2.2 * ( 1 - rubber * 0.32 + bounce ); roadRunner.scale.z = 2.2 * ( 1 + rubber * 0.75 );
		let runRing = roadRunner.getObjectByName( 'road-runner-run-ring' );
		if ( ! runRing && legs ) {
			runRing = new THREE.Group(); runRing.name = 'road-runner-run-ring';
			const legBox = new THREE.Box3().setFromObject( legs ), legSize = legBox.getSize( new THREE.Vector3() );
			const radius = Math.max( 0.18, Math.max( legSize.y, legSize.z ) * 0.55 ), tube = Math.max( 0.016, radius * 0.055 );
			const makeLoop = ( size, material, tubeScale = 1 ) => { const r = radius * size; const curve = new THREE.CatmullRomCurve3( [ new THREE.Vector3(0,.50*r,-1.16*r), new THREE.Vector3(0,.76*r,-.48*r), new THREE.Vector3(0,.72*r,.42*r), new THREE.Vector3(0,.42*r,1.08*r), new THREE.Vector3(0,-.18*r,1.20*r), new THREE.Vector3(0,-.54*r,.48*r), new THREE.Vector3(0,-.46*r,-.56*r), new THREE.Vector3(0,-.02*r,-1.18*r) ], true, 'centripetal' ); return new THREE.Mesh( new THREE.TubeGeometry( curve, 64, tube * tubeScale, 6, true ), material ); };
			const legMat = new THREE.MeshStandardMaterial({color:0xb05b24,roughness:.72,transparent:true,opacity:0}); const speedMat = new THREE.MeshBasicMaterial({color:0xc77837,transparent:true,opacity:0,depthWrite:false});
			const legGroup = new THREE.Group(); legGroup.name='road-runner-leg-cycle'; for(let i=0;i<4;i++){const loop=makeLoop(.88+i*.045,legMat.clone(),1-i*.06);loop.position.x=(i-1.5)*tube*.7;legGroup.add(loop)}
			const speedGroup = new THREE.Group(); speedGroup.name='road-runner-speed-cycle'; for(let i=0;i<5;i++){const loop=makeLoop(.98+i*.035,speedMat.clone(),.52);loop.position.x=(i-2)*tube*.55;speedGroup.add(loop)}
			runRing.add(legGroup,speedGroup); runRing.position.copy(legs.position); roadRunner.add(runRing);
		}
		if ( runRing ) {
			const legGroup=runRing.getObjectByName('road-runner-leg-cycle'), speedGroup=runRing.getObjectByName('road-runner-speed-cycle'); runRing.visible=runBlend>.01; runRing.rotation.set(0,0,0);
			const pulse=1+Math.sin(this.roadRunnerTime*2.2)*.025*runBlend; runRing.scale.set(.70+runBlend*.36,(.74+runBlend*.28)*pulse,.92+speedBlend*.13);
			if(legGroup){const opacity=runBlend*(1-speedBlend*.5)*.92;legGroup.position.y=Math.sin(this.roadRunnerTime*2.6)*.008*runBlend;for(const child of legGroup.children)child.material.opacity=opacity}
			if(speedGroup){const opacity=speedBlend*.82;speedGroup.scale.setScalar(1+Math.sin(this.roadRunnerTime*4.5)*.018*speedBlend);for(const child of speedGroup.children)child.material.opacity=opacity}
		}
		if ( legs?.userData.roadRunnerBase ) { const base=legs.userData.roadRunnerBase, fade=THREE.MathUtils.smoothstep(runBlend,.05,.72); legs.position.copy(base.position); legs.rotation.copy(base.rotation); legs.scale.copy(base.scale).multiplyScalar(Math.max(.04,1-fade*.96)); legs.position.y=base.position.y+fade*.018; }
		if ( bodyTail?.userData.roadRunnerBase ) { const base=bodyTail.userData.roadRunnerBase, flutter=Math.sin(this.roadRunnerTime*1.25)*(.012+speed*.045); bodyTail.rotation.x=lerpAngle(bodyTail.rotation.x,base.rotation.x-accelDelta*.20+flutter,Math.min(1,dt*7)); bodyTail.rotation.z=lerpAngle(bodyTail.rotation.z,base.rotation.z-this.inputX*speed*.16+flutter*.5,Math.min(1,dt*7)); bodyTail.position.z=THREE.MathUtils.lerp(bodyTail.position.z,base.position.z-accelDelta*.07,Math.min(1,dt*6)); }
		if ( head?.userData.roadRunnerBase ) { const base=head.userData.roadRunnerBase; head.rotation.x=lerpAngle(head.rotation.x,base.rotation.x-accelDelta*.13+Math.sin(this.roadRunnerTime*.5)*.018,Math.min(1,dt*8)); head.rotation.z=lerpAngle(head.rotation.z,base.rotation.z+this.inputX*speed*.15,Math.min(1,dt*8)); head.position.y=THREE.MathUtils.lerp(head.position.y,base.position.y+Math.sin(this.roadRunnerTime*.65)*(.006+speed*.014),Math.min(1,dt*8)); }
		if ( eyes?.userData.roadRunnerBase && head?.userData.roadRunnerBase ) { const eyeBase=eyes.userData.roadRunnerBase, headBase=head.userData.roadRunnerBase; _rrBaseHeadQuat.setFromEuler(headBase.rotation); _rrDeltaQuat.copy(head.quaternion).multiply(_rrBaseHeadQuat.invert()); _rrEyeOffset.subVectors(eyeBase.position,headBase.position).applyQuaternion(_rrDeltaQuat); eyes.position.copy(head.position).add(_rrEyeOffset); _rrEyeQuat.setFromEuler(eyeBase.rotation).premultiply(_rrDeltaQuat); eyes.quaternion.copy(_rrEyeQuat); eyes.scale.copy(eyeBase.scale); }
	}
}
