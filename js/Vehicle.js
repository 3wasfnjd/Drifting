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

// Logical speed is now expressed in metres/second at normal scale.
// 18 m/s ~= 65 km/h: fast enough for sustained drifting without the old
// frame-by-frame angular-velocity accumulation that made speed unstable.
export const MAX_SPEED = 18.0;
const ACCELERATION_RATE = 6.5;
const BRAKE_RATE = 13.0;
const COAST_DECELERATION = 1.1;
const HANDBRAKE_DECELERATION = 7.0;
const REVERSE_SPEED_SCALE = 0.35;
const BODY_SUSPENSION_SINK = 0.1;
const ROAD_RUNNER_MAX_SPEED = MAX_SPEED;
const BASE_SPHERE_RADIUS = 0.5;

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

function lerpAngle( a, b, t ) {
	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < - Math.PI ) diff += Math.PI * 2;
	return a + diff * t;
}

function moveTowards( current, target, maxDelta ) {
	if ( current < target ) return Math.min( current + maxDelta, target );
	if ( current > target ) return Math.max( current - maxDelta, target );
	return current;
}

export class Vehicle {
	constructor() {
		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;
		this.spherePos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.sphereVel = new THREE.Vector3();
		this.sphereRadius = 0.5;
		this.visualOffset = 0.5;
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
			if ( wheelChildren.length > 0 ) {
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

			const SINK_TO_CLEARANCE_RATIO = 0.25;
			const targetSink = clearance !== null && clearance > 0
				? SINK_TO_CLEARANCE_RATIO * clearance
				: BODY_SUSPENSION_SINK;
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
		this.inputX = THREE.MathUtils.clamp( controlsInput.x || 0, -1, 1 );
		this.inputZ = THREE.MathUtils.clamp( controlsInput.z || 0, -1, 1 );
		this.handbrake = !! controlsInput.handbrake;

		if ( controlsInput.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {
			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - 3 * dt ) );
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = THREE.MathUtils.clamp( - cross * 2, -1, 1 );
			this.linearSpeed = moveTowards( this.linearSpeed, MAX_SPEED, ACCELERATION_RATE * dt );
		} else {
			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

			const speedRatio = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / MAX_SPEED, 0, 1 );
			const steeringGrip = THREE.MathUtils.lerp( 0.22, 1.0, Math.sqrt( speedRatio ) );
			const effectiveGrip = this.handbrake ? 1.0 : steeringGrip;
			const turnMultiplier = this.handbrake ? 6.5 : 4.0;
			const targetAngular = - this.inputX * effectiveGrip * turnMultiplier * direction;
			const steerResponse = this.handbrake ? 5.0 : 4.0;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, 1 - Math.exp( - steerResponse * dt ) );
			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ >= 0
				? this.inputZ * MAX_SPEED
				: this.inputZ * MAX_SPEED * REVERSE_SPEED_SCALE;

			if ( this.linearSpeed < 1.0 && targetSpeed > MAX_SPEED * 0.65 && this._launchArmed ) {
				this.justLaunched = true;
				this._launchArmed = false;
			} else {
				this.justLaunched = false;
			}
			if ( Math.abs( this.linearSpeed ) > MAX_SPEED * 0.3 || targetSpeed < MAX_SPEED * 0.2 ) this._launchArmed = true;

			if ( this.inputZ < -0.05 && this.linearSpeed > 0.1 ) {
				this.linearSpeed = moveTowards( this.linearSpeed, 0, BRAKE_RATE * dt );
			} else if ( Math.abs( this.inputZ ) <= 0.05 ) {
				this.linearSpeed = moveTowards( this.linearSpeed, 0, COAST_DECELERATION * dt );
			} else {
				const rate = Math.abs( targetSpeed ) < Math.abs( this.linearSpeed ) ? BRAKE_RATE : ACCELERATION_RATE;
				this.linearSpeed = moveTowards( this.linearSpeed, targetSpeed, rate * dt );
			}
		}

		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );
		if ( _tmpVec.y > 0.5 ) {
			const targetQuat = this.alignWithY( this.container.quaternion, _up );
			this.container.quaternion.slerp( targetQuat, 0.2 );
		}

		if ( this.handbrake ) this.linearSpeed = moveTowards( this.linearSpeed, 0, HANDBRAKE_DECELERATION * dt );

		if ( this.rigidBody ) {
			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();
			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const speedRatio = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / MAX_SPEED, 0, 1 );
			const driftLoad = Math.abs( this.inputX ) * speedRatio;
			const driveResponse = this.handbrake ? 1.8 : THREE.MathUtils.lerp( 8.0, 4.5, driftLoad );
			const blend = 1 - Math.exp( - driveResponse * dt );

			// Rolling constraint: v = r*w. Because AR scales both the world
			// speed and sphere radius together, the required angular speed is
			// scale-independent and stays consistent between Web and AR.
			const targetSpin = this.linearSpeed / BASE_SPHERE_RADIUS;
			const targetX = _right.x * targetSpin;
			const targetZ = _right.z * targetSpin;
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [
				THREE.MathUtils.lerp( angvel[ 0 ], targetX, blend ),
				angvel[ 1 ],
				THREE.MathUtils.lerp( angvel[ 2 ], targetZ, blend )
			] );

			const pos = this.rigidBody.position;
			this.spherePos.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[ 0 ], vel[ 1 ], vel[ 2 ] );
		}

		this.acceleration = THREE.MathUtils.lerp(
			this.acceleration,
			this.linearSpeed,
			1 - Math.exp( - 5 * dt )
		);

		const respawnDropDistance = Math.max( 2.0 * ( this.sphereRadius / BASE_SPHERE_RADIUS ), 0.05 );
		const respawnYLimit = this.spawnPos.y - respawnDropDistance;
		if ( this.spherePos.y < respawnYLimit ) {
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
			this.container.rotation.set( 0, this.spawnAngle, 0 );
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
		const logicalLateralSlip = Math.abs( this.sphereVel.dot( _right ) ) / scaleRatio;
		const normalizedSpeed = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / MAX_SPEED, 0, 1 );
		this.driftIntensity = logicalLateralSlip / 4.0 +
			( this.handbrake ? 0.75 : 0 ) +
			Math.abs( this.inputX ) * normalizedSpeed * 0.9;
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
		const speedRatio = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ) / MAX_SPEED, 0, 1 );
		const pitch = THREE.MathUtils.clamp( - ( this.linearSpeed - this.acceleration ) / MAX_SPEED * 0.22, -0.12, 0.12 );
		const roll = - this.inputX * speedRatio * ( this.handbrake ? 0.24 : 0.18 );
		this.bodyNode.rotation.x = lerpAngle( this.bodyNode.rotation.x, pitch, 1 - Math.exp( - 10 * dt ) );
		this.bodyNode.rotation.z = lerpAngle( this.bodyNode.rotation.z, roll, 1 - Math.exp( - 5 * dt ) );
		this.bodyNode.position.y = THREE.MathUtils.lerp(
			this.bodyNode.position.y,
			this._bodyRestY - this._bodySuspensionSinkLocal,
			1 - Math.exp( - 5 * dt )
		);
	}

	updateWheels( dt ) {
		const wheelSpin = ( this.linearSpeed / 0.35 ) * dt;
		for ( const wheel of this.wheels ) wheel.rotation.x += wheelSpin;
		if ( this.wheelFL ) this.wheelFL.rotation.y = lerpAngle( this.wheelFL.rotation.y, - this.inputX / 1.5, 1 - Math.exp( - 10 * dt ) );
		if ( this.wheelFR ) this.wheelFR.rotation.y = lerpAngle( this.wheelFR.rotation.y, - this.inputX / 1.5, 1 - Math.exp( - 10 * dt ) );
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
		this.roadRunnerRunBlend = THREE.MathUtils.lerp( this.roadRunnerRunBlend, legTarget, 1 - Math.exp( - dt * 6.5 ) );
		const run = this.roadRunnerRunBlend, fast = THREE.MathUtils.clamp( ringTarget * run, 0, 1 );
		this.roadRunnerTime += dt * ( 4 + speed * 36 );
		const ad = THREE.MathUtils.clamp( ( this.linearSpeed - this.acceleration ) / MAX_SPEED, -.7, .7 ), rubber = ad * .11, bounce = Math.sin( this.roadRunnerTime * .55 ) * .018 * speed;
		r.scale.x = 2.2 * ( 1 - Math.abs( rubber ) * .35 );
		r.scale.y = 2.2 * ( 1 - rubber * .32 + bounce );
		r.scale.z = 2.2 * ( 1 + rubber * .75 );
		let ring = r.getObjectByName( 'road-runner-run-ring' );
		if ( ! ring && legs ) {
			ring = new THREE.Group(); ring.name = 'road-runner-run-ring';
			const box = new THREE.Box3().setFromObject( legs ), size = box.getSize( new THREE.Vector3() ), rad = Math.max( .18, Math.max( size.y, size.z ) * .55 ), tube = Math.max( .016, rad * .055 );
			const make = ( s, m, ts = 1 ) => { const rr = rad * s, curve = new THREE.CatmullRomCurve3( [new THREE.Vector3(0,.50*rr,-1.16*rr),new THREE.Vector3(0,.76*rr,-.48*rr),new THREE.Vector3(0,.72*rr,.42*rr),new THREE.Vector3(0,.42*rr,1.08*rr),new THREE.Vector3(0,-.18*rr,1.20*rr),new THREE.Vector3(0,-.54*rr,.48*rr),new THREE.Vector3(0,-.46*rr,-.56*rr),new THREE.Vector3(0,-.02*rr,-1.18*rr)], true, 'centripetal' ); return new THREE.Mesh( new THREE.TubeGeometry( curve, 64, tube * ts, 6, true ), m ); };
			const lm = new THREE.MeshStandardMaterial({color:0xb05b24,roughness:.72,transparent:true,opacity:0}), sm = new THREE.MeshBasicMaterial({color:0xc77837,transparent:true,opacity:0,depthWrite:false}), lg = new THREE.Group(); lg.name='road-runner-leg-cycle';
			for(let i=0;i<4;i++){const l=make(.88+i*.045,lm.clone(),1-i*.06);l.position.x=(i-1.5)*tube*.7;lg.add(l)}
			const sg=new THREE.Group();sg.name='road-runner-speed-cycle';for(let i=0;i<5;i++){const l=make(.98+i*.035,sm.clone(),.52);l.position.x=(i-2)*tube*.55;sg.add(l)}ring.add(lg,sg);ring.position.copy(legs.position);r.add(ring)
		}
		if(ring){const lg=ring.getObjectByName('road-runner-leg-cycle'),sg=ring.getObjectByName('road-runner-speed-cycle');ring.visible=run>.01;ring.rotation.set(0,0,0);const pulse=1+Math.sin(this.roadRunnerTime*2.2)*.025*run;ring.scale.set(.70+run*.36,(.74+run*.28)*pulse,.92+fast*.13);if(lg){const op=run*(1-fast*.5)*.92;lg.position.y=Math.sin(this.roadRunnerTime*2.6)*.008*run;for(const c of lg.children)c.material.opacity=op}if(sg){const op=fast*.82;sg.scale.setScalar(1+Math.sin(this.roadRunnerTime*4.5)*.018*fast);for(const c of sg.children)c.material.opacity=op}}
		if(legs?.userData.roadRunnerBase){const b=legs.userData.roadRunnerBase,f=THREE.MathUtils.smoothstep(run,.05,.72);legs.position.copy(b.position);legs.rotation.copy(b.rotation);legs.scale.copy(b.scale).multiplyScalar(Math.max(.04,1-f*.96));legs.position.y=b.position.y+f*.018}
		if(bt?.userData.roadRunnerBase){const b=bt.userData.roadRunnerBase,fl=Math.sin(this.roadRunnerTime*1.25)*(.012+speed*.045);bt.rotation.x=lerpAngle(bt.rotation.x,b.rotation.x-ad*.20+fl,Math.min(1,dt*7));bt.rotation.z=lerpAngle(bt.rotation.z,b.rotation.z-this.inputX*speed*.16+fl*.5,Math.min(1,dt*7));bt.position.z=THREE.MathUtils.lerp(bt.position.z,b.position.z-ad*.07,Math.min(1,dt*6))}
		if(head?.userData.roadRunnerBase){const b=head.userData.roadRunnerBase;head.rotation.x=lerpAngle(head.rotation.x,b.rotation.x-ad*.13+Math.sin(this.roadRunnerTime*.5)*.018,Math.min(1,dt*8));head.rotation.z=lerpAngle(head.rotation.z,b.rotation.z+this.inputX*speed*.15,Math.min(1,dt*8));head.position.y=THREE.MathUtils.lerp(head.position.y,b.position.y+Math.sin(this.roadRunnerTime*.65)*(.006+speed*.014),Math.min(1,dt*8))}
		if(eyes?.userData.roadRunnerBase&&head?.userData.roadRunnerBase){const eb=eyes.userData.roadRunnerBase,hb=head.userData.roadRunnerBase;_rrBaseHeadQuat.setFromEuler(hb.rotation);_rrDeltaQuat.copy(head.quaternion).multiply(_rrBaseHeadQuat.invert());_rrEyeOffset.subVectors(eb.position,hb.position).applyQuaternion(_rrDeltaQuat);eyes.position.copy(head.position).add(_rrEyeOffset);_rrEyeQuat.setFromEuler(eb.rotation).premultiply(_rrDeltaQuat);eyes.quaternion.copy(_rrEyeQuat);eyes.scale.copy(eb.scale)}
	}
}
