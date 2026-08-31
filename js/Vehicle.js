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
const _rrDeltaQuat = new THREE.Quaternion();
const _rrBaseHeadQuat = new THREE.Quaternion();
const _rrEyeQuat = new THREE.Quaternion();
const _rrEyeOffset = new THREE.Vector3();

const LINEAR_DAMP = 0.1;
export const MAX_SPEED = 2.4;
const VEHICLE_ACCELERATION = 2.6;
const ROAD_RUNNER_MAX_SPEED = MAX_SPEED;
const ROAD_RUNNER_ACCELERATION = VEHICLE_ACCELERATION;
const REVERSE_SPEED_SCALE = 0.6;
const BODY_SUSPENSION_SINK = 0.1;

function lerpAngle( a, b, t ) {
	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < -Math.PI ) diff += Math.PI * 2;
	return a + diff * t;
}

// Same strategy used by Hajwala: animate a clean pivot instead of overwriting
// rotations baked into imported GLB body/wheel nodes.
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
				for ( const wheel of wheelChildren ) {
					wheelBox.setFromObject( wheel );
					lowestWheelY = Math.min( lowestWheelY, wheelBox.min.y );
				}
				clearance = bodyBox.min.y - lowestWheelY;
			}
			const targetSink = clearance !== null && clearance > 0 ? clearance * 0.18 : BODY_SUSPENSION_SINK;
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
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - ( this.handbrake ? 5.2 : 3.2 ) * dt ) );
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( - cross * 2, -1, 1 );
			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, maxSpeed, Math.min( 1, dt * accelerationRate ) );
		} else {
			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

			const speedRatio = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / Math.max( maxSpeed, 0.001 ), 0, 1 );
			const steeringGrip = THREE.MathUtils.lerp( 0.34, 1, speedRatio );
			const effectiveGrip = this.handbrake ? 1 : steeringGrip;
			const turnMultiplier = this.handbrake ? 6.5 : 4.0;
			const targetAngular = - this.inputX * effectiveGrip * turnMultiplier * direction;
			const steeringResponse = this.handbrake ? 5.8 : 4.2;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, Math.min( 1, dt * steeringResponse ) );
			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ;
			if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) {
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0, Math.min( 1, dt * 8 ) );
			} else if ( targetSpeed < 0 ) {
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed * REVERSE_SPEED_SCALE, Math.min( 1, dt * 2.5 ) );
			} else {
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * maxSpeed, Math.min( 1, dt * accelerationRate ) );
			}
		}

		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );
		if ( _tmpVec.y > 0.5 ) this.container.quaternion.slerp( this.alignWithY( this.container.quaternion, _up ), 0.20 );

		this.linearSpeed *= Math.max( 0, 1 - LINEAR_DAMP * dt );
		if ( this.handbrake ) this.linearSpeed *= Math.max( 0, 1 - 1.2 * dt );

		if ( this.rigidBody ) {
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();
			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const radiusRatio = 0.5 / Math.max( this.sphereRadius || this.visualOffset || 0.5, 0.001 );
			const drive = this.linearSpeed * 100 * dt * radiusRatio;
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
			this.linearSpeed + 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ),
			dt
		);

		const respawnDrop = Math.max( 2 * ( ( this.sphereRadius || 0.5 ) / 0.5 ), 0.05 );
		if ( this.spherePos.y < this.spawnPos.y - respawnDrop ) {
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
		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) +
			( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 2 : 0 ) +
			( this.handbrake ? 0.7 : 0 ) +
			Math.abs( this.inputX ) * Math.abs( this.linearSpeed ) * 0.6;
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
		const pitch = THREE.MathUtils.clamp( -( this.linearSpeed - this.acceleration ) / 8, -0.14, 0.14 );
		const roll = THREE.MathUtils.clamp( -( this.inputX / 7 ) * Math.abs( this.linearSpeed ), -0.18, 0.18 );
		this.bodyNode.rotation.x = lerpAngle( this.bodyNode.rotation.x, pitch, Math.min( 1, dt * 8 ) );
		this.bodyNode.rotation.z = lerpAngle( this.bodyNode.rotation.z, roll, Math.min( 1, dt * 6 ) );
		const targetY = ( this._bodyRestY ?? this.bodyNode.position.y ) - ( this._bodySuspensionSinkLocal ?? 0 );
		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, targetY, Math.min( 1, dt * 5 ) );
	}

	updateWheels( dt ) {
		for ( const wheel of this.wheels ) wheel.rotation.x += this.acceleration;
		const steer = - this.inputX / 1.7;
		if ( this.wheelFL ) this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, steer, Math.min( 1, dt * 10 ) );
		if ( this.wheelFR ) this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, steer, Math.min( 1, dt * 10 ) );
	}

	updateRoadRunner( dt ) {
		const r = this.container.getObjectByName( 'road-runner-free-ar' );
		if ( ! r || ! r.visible ) return;
		const bt = r.getObjectByName( 'Object_2' );
		const legs = r.getObjectByName( 'Object_3' );
		const eyes = r.getObjectByName( 'Object_4' );
		const head = r.getObjectByName( 'Object_5' );
		for ( const n of [ bt, legs, eyes, head ] ) if ( n && ! n.userData.roadRunnerBase ) n.userData.roadRunnerBase = { position:n.position.clone(), rotation:n.rotation.clone(), scale:n.scale.clone() };
		const speed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / ROAD_RUNNER_MAX_SPEED, 0, 1 );
		const legTarget = THREE.MathUtils.smoothstep( speed, .07, .40 );
		const ringTarget = THREE.MathUtils.smoothstep( speed, .45, .82 );
		this.roadRunnerRunBlend = THREE.MathUtils.lerp( this.roadRunnerRunBlend, legTarget, 1 - Math.exp( -dt * 6.5 ) );
		const run = this.roadRunnerRunBlend, fast = THREE.MathUtils.clamp( ringTarget * run, 0, 1 );
		this.roadRunnerTime += dt * ( 4 + speed * 36 );
		const ad = THREE.MathUtils.clamp( this.linearSpeed - this.acceleration, -.7, .7 );
		const rubber = ad * .11, bounce = Math.sin( this.roadRunnerTime * .55 ) * .018 * speed;
		r.scale.x = 2.2 * ( 1 - Math.abs( rubber ) * .35 );
		r.scale.y = 2.2 * ( 1 - rubber * .32 + bounce );
		r.scale.z = 2.2 * ( 1 + rubber * .75 );
		let ring = r.getObjectByName( 'road-runner-run-ring' );
		if ( ! ring && legs ) {
			ring = new THREE.Group(); ring.name = 'road-runner-run-ring';
			const box = new THREE.Box3().setFromObject( legs ), size = box.getSize( new THREE.Vector3() ), rad = Math.max( .18, Math.max( size.y, size.z ) * .55 ), tube = Math.max( .016, rad * .055 );
			const make = ( s, m, ts = 1 ) => { const rr = rad * s, curve = new THREE.CatmullRomCurve3( [ new THREE.Vector3(0,.50*rr,-1.16*rr),new THREE.Vector3(0,.76*rr,-.48*rr),new THREE.Vector3(0,.72*rr,.42*rr),new THREE.Vector3(0,.42*rr,1.08*rr),new THREE.Vector3(0,-.18*rr,1.20*rr),new THREE.Vector3(0,-.54*rr,.48*rr),new THREE.Vector3(0,-.46*rr,-.56*rr),new THREE.Vector3(0,-.02*rr,-1.18*rr) ], true, 'centripetal' ); return new THREE.Mesh( new THREE.TubeGeometry( curve,64,tube*ts,6,true ), m ); };
			const lm = new THREE.MeshStandardMaterial({color:0xb05b24,roughness:.72,transparent:true,opacity:0}), sm = new THREE.MeshBasicMaterial({color:0xc77837,transparent:true,opacity:0,depthWrite:false}), lg = new THREE.Group();
			lg.name='road-runner-leg-cycle'; for(let i=0;i<4;i++){const l=make(.88+i*.045,lm.clone(),1-i*.06);l.position.x=(i-1.5)*tube*.7;lg.add(l)}
			const sg=new THREE.Group();sg.name='road-runner-speed-cycle';for(let i=0;i<5;i++){const l=make(.98+i*.035,sm.clone(),.52);l.position.x=(i-2)*tube*.55;sg.add(l)}
			ring.add(lg,sg);ring.position.copy(legs.position);r.add(ring);
		}
		if(ring){const lg=ring.getObjectByName('road-runner-leg-cycle'),sg=ring.getObjectByName('road-runner-speed-cycle');ring.visible=run>.01;ring.rotation.set(0,0,0);const pulse=1+Math.sin(this.roadRunnerTime*2.2)*.025*run;ring.scale.set(.70+run*.36,(.74+run*.28)*pulse,.92+fast*.13);if(lg){const op=run*(1-fast*.5)*.92;lg.position.y=Math.sin(this.roadRunnerTime*2.6)*.008*run;for(const c of lg.children)c.material.opacity=op}if(sg){const op=fast*.82;sg.scale.setScalar(1+Math.sin(this.roadRunnerTime*4.5)*.018*fast);for(const c of sg.children)c.material.opacity=op}}
		if(legs?.userData.roadRunnerBase){const b=legs.userData.roadRunnerBase,f=THREE.MathUtils.smoothstep(run,.05,.72);legs.position.copy(b.position);legs.rotation.copy(b.rotation);legs.scale.copy(b.scale).multiplyScalar(Math.max(.04,1-f*.96));legs.position.y=b.position.y+f*.018}
		if(bt?.userData.roadRunnerBase){const b=bt.userData.roadRunnerBase,fl=Math.sin(this.roadRunnerTime*1.25)*(.012+speed*.045);bt.rotation.x=lerpAngle(bt.rotation.x,b.rotation.x-ad*.20+fl,Math.min(1,dt*7));bt.rotation.z=lerpAngle(bt.rotation.z,b.rotation.z-this.inputX*speed*.16+fl*.5,Math.min(1,dt*7));bt.position.z=THREE.MathUtils.lerp(bt.position.z,b.position.z-ad*.07,Math.min(1,dt*6))}
		if(head?.userData.roadRunnerBase){const b=head.userData.roadRunnerBase;head.rotation.x=lerpAngle(head.rotation.x,b.rotation.x-ad*.13+Math.sin(this.roadRunnerTime*.5)*.018,Math.min(1,dt*8));head.rotation.z=lerpAngle(head.rotation.z,b.rotation.z+this.inputX*speed*.15,Math.min(1,dt*8));head.position.y=THREE.MathUtils.lerp(head.position.y,b.position.y+Math.sin(this.roadRunnerTime*.65)*(.006+speed*.014),Math.min(1,dt*8))}
		if(eyes?.userData.roadRunnerBase&&head?.userData.roadRunnerBase){const eb=eyes.userData.roadRunnerBase,hb=head.userData.roadRunnerBase;_rrBaseHeadQuat.setFromEuler(hb.rotation);_rrDeltaQuat.copy(head.quaternion).multiply(_rrBaseHeadQuat.invert());_rrEyeOffset.subVectors(eb.position,hb.position).applyQuaternion(_rrDeltaQuat);eyes.position.copy(head.position).add(_rrEyeOffset);_rrEyeQuat.setFromEuler(eb.rotation).premultiply(_rrDeltaQuat);eyes.quaternion.copy(_rrEyeQuat);eyes.scale.copy(eb.scale)}
	}
}
