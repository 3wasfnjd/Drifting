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

// How far the body sinks below its OWN modeled rest height for the
// suspension-settle effect. Derived from the original truck body (modeled
// at y=0.4, previously hard-snapped to an absolute y=0.3 — i.e. a 0.1
// sink). Applying it as a relative offset from each model's own rest
// height, instead of that flat absolute value, keeps the truck's look
// identical while giving any other model (different proportions) a small
// sensible settle instead of being yanked to an unrelated absolute height.
const BODY_SUSPENSION_SINK = 0.1;

// Re-parents `node` under a freshly created pivot Group with an identity
// rotation, inserted at node's original position (so nothing visually
// moves). Imported models — especially ones not from this project's own
// Godot pipeline — often bake an arbitrary corrective rotation directly
// onto the "body"/"wheel" node itself (axis-convention fixes, mirrored
// geometry for the right-side wheels, etc). Animating that node's
// rotation/position DIRECTLY, as this class used to do, overwrites that
// baked correction and produces exactly the kind of "flipped upright"
// body or "spinning on the wrong axis" wheel seen on non-Godot models.
// The pivot's axes always match the model's overall (correctly
// Y-up-oriented) frame, so animating the PIVOT instead works regardless
// of whatever the artist baked onto the node itself — and is a no-op for
// models where the node had no baked rotation to begin with (the
// original truck models), since the pivot starts at identity and simply
// carries the untouched node along with it.
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

// Reverse tops out at this fraction of MAX_SPEED — real cars reverse
// slower than they drive forward, but not as crawlingly slow as before
// (was effectively ~0.33). Raise toward 1.0 for a stronger reverse,
// lower it for a weaker one; keep it below 1.0 so it never matches
// forward power.
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

		this.spherePos = new THREE.Vector3( 3.5, 0.5, 5 );
		this.sphereVel = new THREE.Vector3();
		this.sphereRadius = 0.5; // overridable — AR floating-track/arena use a scaled-down sphere to match a shrunk track
		this.spawnPos = null;
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

		this.driftIntensity = 0;
		this.justLaunched = false;
		this._launchArmed = true;

	}

	init( model ) {

		const vehicleModel = model.clone();

		this.container.add( vehicleModel );

		// Pass 1: find body/wheel nodes by name. Read-only — do NOT
		// mutate the hierarchy while traverse() is still walking it.
		let bodyChild = null;
		const wheelChildren = [];

		vehicleModel.traverse( ( child ) => {

			const name = child.name.toLowerCase();

			if ( name === 'body' ) {

				bodyChild = child;

			} else if ( name.includes( 'wheel' ) ) {

				wheelChildren.push( child );

			}

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;

			}

		} );

		// Pass 2: wrap each found node in its own clean pivot (see
		// createPivot() above) and animate the pivot from here on.
		if ( bodyChild ) {

			this.bodyNode = createPivot( bodyChild );
			this._bodyRestY = this.bodyNode.position.y;

			// BODY_SUSPENSION_SINK (see its comment above) was calibrated
			// as a flat LOCAL-unit delta against the truck's own body
			// frame — which includes vehicleModel's own normal 0.5
			// scale, already "priced in" to that calibration (0.4 rest
			// → 0.3 target is the real, verified truck behavior). What
			// breaks on a different model isn't vehicleModel's own
			// scale — it's any EXTRA, unexpected unit scale baked onto
			// the body node's ancestors ABOVE vehicleModel's own scale.
			// Confirmed on vehicle-camry.glb (a Sketchfab/FBX-sourced
			// asset): a 100x centimeters-vs-meters artifact several
			// levels up its own internal hierarchy, on top of the usual
			// vehicleModel scale — which made a flat local-unit
			// subtraction here only about 1/300th of the intended
			// real-world sink (the Camry's body never visibly settled
			// onto its suspension). Comparing the body pivot's own
			// accumulated world scale against vehicleModel's — rather
			// than against 1 — isolates just that extra factor (0.01
			// for the Camry) and leaves vehicleModel's own expected
			// scale untouched, so this is a verified no-op for the
			// truck AND the Camaro, which have no such extra ancestor
			// scale (both measure exactly 1 here).
			this.bodyNode.getWorldScale( _tmpScale );
			vehicleModel.getWorldScale( _tmpScale2 );
			const extraLocalScale = _tmpScale.y / Math.max( _tmpScale2.y, 0.0001 );

			// A flat BODY_SUSPENSION_SINK (reported: the Camry and Camaro
			// visibly sink into the ground the instant they spawn, unlike
			// the truck) turned out to still be wrong even with the
			// extraLocalScale fix above: that fix makes the sink land at
			// the SAME flat 0.1 units in every model's vehicleModel-frame
			// regardless of hidden nested scale, but 0.1 was calibrated
			// specifically against the truck's own generous body-to-wheel
			// clearance (0.4 units) — a low sports car's clearance is far
			// smaller (measured directly off the .glb geometry: ≈0.15 for
			// the Camry, ≈0.10 for the Camaro), so that same flat 0.1
			// consumes nearly ALL of it, dropping the underbody almost to
			// the wheels' own contact point. Scaling the sink to the same
			// fraction of EACH model's own measured clearance that 0.1
			// already is of the truck's (0.1 / 0.4 = 25%) reproduces the
			// truck's exact prior behavior (a verified no-op: its own
			// measured clearance is that same 0.4) while giving the
			// Camry/Camaro a proportionally identical, much smaller settle
			// instead of one that eats their whole suspension travel.
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

			const SINK_TO_CLEARANCE_RATIO = 0.25; // = BODY_SUSPENSION_SINK / the truck's own 0.4 clearance
			const targetSink = ( clearance !== null && clearance > 0 )
				? SINK_TO_CLEARANCE_RATIO * clearance
				: BODY_SUSPENSION_SINK; // no wheels found to measure against — fall back to the flat original
			this._bodySuspensionSinkLocal = targetSink / Math.max( extraLocalScale, 0.0001 );

		}

		wheelChildren.forEach( ( child ) => {

			const name = child.name.toLowerCase();
			const pivot = createPivot( child );
			this.wheels.push( pivot );

			if ( name.includes( 'front' ) && name.includes( 'left' ) ) this.wheelFL = pivot;
			if ( name.includes( 'front' ) && name.includes( 'right' ) ) this.wheelFR = pivot;
			if ( name.includes( 'back' ) && name.includes( 'left' ) ) this.wheelBL = pivot;
			if ( name.includes( 'back' ) && name.includes( 'right' ) ) this.wheelBR = pivot;

		} );

		return this.container;

	}

	update( dt, controlsInput ) {

		this.inputX = controlsInput.x;
		this.inputZ = controlsInput.z;
		this.handbrake = !! controlsInput.handbrake;

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

			// Handbrake: the rear tires lose grip, so steering authority
			// no longer depends on speed (full grip regardless) and turns
			// noticeably sharper — the classic arcade handbrake-turn.
			const effectiveGrip = this.handbrake ? 1.0 : steeringGrip;
			const turnMultiplier = this.handbrake ? 6.5 : 4;

			const targetAngular = - this.inputX * effectiveGrip * turnMultiplier * direction;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, dt * 4 );

			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ;

			// Launch detection: edge-triggered flag (true for exactly one
			// frame) when the player floors it from a near-standstill —
			// main.js uses this to fire a one-shot drag-style tire chirp.
			// Re-armed once the car is moving well or off the throttle, so
			// it can fire again next time you stop and floor it.
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

		// Handbrake scrubs off extra speed — real rear tires dragging
		// sideways lose grip AND energy, not just direction.
		if ( this.handbrake ) this.linearSpeed *= Math.max( 0, 1 - 1.2 * dt );

		if ( this.rigidBody ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const radiusRatio = 0.5 / Math.max( this.sphereRadius, 0.001 );
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
			this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ),
			dt
		);

		// How far below spawn counts as "fell off" before the safety-net
		// respawn below kicks in. The flat "2.0" this used to be is a
		// real-world-meters constant — fine at NORMAL mode's radius-0.5
		// scale, but at AR's shrunk sphereRadius (e.g. ~0.008 for the
		// floating track/arena) it demanded falling a full 2 REAL
		// meters below a tabletop-sized track before ever triggering.
		// If the tiny AR physics sphere ever tunnels through the floor
		// (a real risk at that scale — see Physics.js/createSphereBody),
		// it would just fall forever, invisible, with this recovery
		// never firing: exactly what reads as the car "getting stuck"
		// (it didn't freeze, it fell out of the world and never came
		// back). Scaling the drop distance by the same sphereRadius/0.5
		// ratio used elsewhere for AR proportions keeps this trigger
		// meaningful at any scale — unchanged (2.0) at radius 0.5.
		const respawnDropDistance = Math.max( 2.0 * ( this.sphereRadius / 0.5 ), 0.05 );
		const respawnYLimit = ( this.spawnPos ? this.spawnPos[ 1 ] - respawnDropDistance : - 10 );
		if ( this.spherePos.y < respawnYLimit ) {

			const rx = this.spawnPos ? this.spawnPos[ 0 ] : 3.5;
			const ry = this.spawnPos ? this.spawnPos[ 1 ] : 0.5;
			const rz = this.spawnPos ? this.spawnPos[ 2 ] : 5;
			const rAngle = this.spawnAngle || 0;

			if ( this.rigidBody ) {

				rigidBody.setPosition( this.physicsWorld, this.rigidBody, [ rx, ry, rz ], false );
				rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );
				rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );

			}

			this.spherePos.set( rx, ry, rz );
			this.sphereVel.set( 0, 0, 0 );
			this.linearSpeed = 0;
			this.angularSpeed = 0;
			this.acceleration = 0;
			this.container.rotation.set( 0, rAngle, 0 );
			this.container.quaternion.setFromAxisAngle( _up, rAngle );

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

		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) +
			( this.bodyNode ? Math.abs( this.bodyNode.rotation.z ) * 2 : 0 ) +
			( this.handbrake ? 0.7 : 0 ) +
			// Direct cornering severity: steering input × current speed.
			// The body-lean term above is a damped/lerped visual value
			// that lags behind the actual input and, in practice, rarely
			// climbed high enough on its own during ordinary hard
			// cornering (as opposed to a full handbrake turn) to cross
			// Audio.js's skid threshold. This responds immediately.
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

		this.bodyNode.position.y = THREE.MathUtils.lerp( this.bodyNode.position.y, this._bodyRestY - this._bodySuspensionSinkLocal, dt * 5 );

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

}
