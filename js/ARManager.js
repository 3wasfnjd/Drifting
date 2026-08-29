import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { rigidBody, box, MotionType } from 'crashcat';

// ARManager: free-roam AR mode. No TRACK_CELLS, no fixed track — the
// player places a spawn point/heading in their real room, then drives on
// the real (passthrough) floor with real furniture as solid obstacles
// (via Meta's WebXR mesh-detection, best-effort).
//
// It deliberately knows nothing about the Vehicle class or vehicle physics.
// After placement it only exposes getDriveInput()/isPlaced()/getSpawnWorld()
// so main.js can spawn and drive the existing Vehicle exactly like in
// NORMAL mode.

const DEADZONE = 0.15;
const MOVE_SPEED = 1.5;   // m/s at full stick deflection
const ROTATE_SPEED = 1.2; // rad/s at full stick deflection

export class ARManager {

	constructor( { renderer, scene, models } ) {

		this.renderer = renderer;
		this.scene = scene;
		this.models = models;

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;

		this.hasHit = false;
		this.placed = false;

		this.arPosition = new THREE.Vector3();
		this.arQuaternion = new THREE.Quaternion();

		this.previewGroup = this.buildPreviewMesh();
		this.previewGroup.visible = false;
		this.scene.add( this.previewGroup );

		this.world = null; // set by main.js via setWorld() before session start

		this.gamepads = { left: null, right: null };
		this.controllers = { left: null, right: null };
		this._prevTrigger = { left: false, right: false };
		this._prevRadioButtons = { x: false, y: false };
		this._prevHeadlightButton = false;
		this._prevHazardButton = false;

		this.controllerModelFactory = new XRControllerModelFactory();
		this._setupControllers();

		this._savedBackground = null;
		this._savedFog = null;

		this.onPlaced = null; // callback({position: Vector3, angle: number})

		this._camForward = new THREE.Vector3();
		this._camPos = new THREE.Vector3();

	}

	setWorld( world ) {

		this.world = world;

	}

	// ─── UI entry point ───────────────────────────────────

	static async isSupported() {

		if ( ! navigator.xr ) return false;
		try {

			return await navigator.xr.isSessionSupported( 'immersive-ar' );

		} catch ( e ) {

			return false;

		}

	}

	async requestSession( pendingSession = null ) {

		const session = pendingSession ? await pendingSession : await navigator.xr.requestSession( 'immersive-ar', {
			requiredFeatures: [ 'local-floor', 'hit-test' ],
			// Meta/Quest-specific room awareness. Optional: if unsupported,
			// the session still starts fine and we just skip that part.
			optionalFeatures: [ 'plane-detection', 'mesh-detection' ],
		} );

		this.renderer.xr.setReferenceSpaceType( 'local-floor' );
		await this.renderer.xr.setSession( session );

		this.session = session;
		session.addEventListener( 'end', () => this._onSessionEnd() );

		this._savedBackground = this.scene.background;
		this._savedFog = this.scene.fog;
		this.scene.background = null; // let passthrough show through
		this.scene.fog = null;

		this.previewGroup.visible = true;

		console.log( '[ARManager] AR session started. environmentBlendMode:', session.environmentBlendMode );

		return session;

	}

	// ─── Controllers ──────────────────────────────────────

	_setupControllers() {

		for ( let i = 0; i < 2; i ++ ) {

			const controller = this.renderer.xr.getController( i );
			controller.addEventListener( 'connected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = event.data.gamepad || null;
				this.controllers[ hand ] = controller;

			} );
			controller.addEventListener( 'disconnected', ( event ) => {

				const hand = event.data.handedness === 'left' ? 'left' : 'right';
				this.gamepads[ hand ] = null;

			} );
			this.scene.add( controller );

			const grip = this.renderer.xr.getControllerGrip( i );
			this.scene.add( grip );

			// Cosmetic only (renders a controller model in-view). Never
			// let a failure here (e.g. the input-profile asset fetch)
			// break placement or driving.
			try {

				grip.add( this.controllerModelFactory.createControllerModel( grip ) );

			} catch ( e ) {

				console.warn( 'Controller model failed to load (non-fatal):', e );

			}

		}

	}

	// ─── Preview visuals ──────────────────────────────────
	// Just a spawn-point ring + forward arrow now — there's no track
	// footprint to preview anymore.

	buildPreviewMesh() {

		const group = new THREE.Group();

		const ring = new THREE.Mesh(
			new THREE.RingGeometry( 0.45, 0.55, 32 ),
			new THREE.MeshBasicMaterial( { color: 0x15A249, transparent: true, opacity: 0.8, side: THREE.DoubleSide } )
		);
		ring.rotation.x = - Math.PI / 2;
		ring.position.y = 0.02;
		group.add( ring );

		const fill = new THREE.Mesh(
			new THREE.CircleGeometry( 0.45, 32 ),
			new THREE.MeshBasicMaterial( { color: 0x15A249, transparent: true, opacity: 0.25, side: THREE.DoubleSide } )
		);
		fill.rotation.x = - Math.PI / 2;
		fill.position.y = 0.015;
		group.add( fill );

		const arrow = new THREE.Mesh(
			new THREE.ConeGeometry( 0.14, 0.5, 12 ),
			new THREE.MeshBasicMaterial( { color: 0x159897 } )
		);
		arrow.rotation.x = Math.PI / 2;
		arrow.position.set( 0, 0.05, -0.55 );
		group.add( arrow );

		return group;

	}

	// ─── Per-frame update (called from the shared animate loop) ──

	update( frame, dt ) {

		if ( ! this.session || ! frame ) return;

		try {

			const refSpace = this.renderer.xr.getReferenceSpace();
			this._ensureHitTestSource();

			if ( ! this.placed ) {

				this._updatePlacement( frame, refSpace, dt );

			}

		} catch ( e ) {

			console.error( '[ARManager] update() error:', e );

		}

	}

	// Requests the hit-test source exactly once per session — split out of
	// update() so updateExternalPlacement() (used by the floating track/
	// arena — see below) can share the same request instead of duplicating
	// it.
	_ensureHitTestSource() {

		if ( this.hitTestSourceRequested ) return;
		this.hitTestSourceRequested = true;

		this.session.requestReferenceSpace( 'viewer' ).then( ( viewerSpace ) => {

			this.session.requestHitTestSource( { space: viewerSpace } ).then( ( source ) => {

				this.hitTestSource = source;

			} ).catch( ( e ) => console.warn( '[ARManager] requestHitTestSource failed:', e ) );

		} ).catch( ( e ) => console.warn( '[ARManager] requestReferenceSpace(viewer) failed:', e ) );

	}

	_updatePlacement( frame, refSpace, dt ) {

		this._updateHitTestPose( frame, refSpace, dt );

		this.previewGroup.position.copy( this.arPosition );
		this.previewGroup.quaternion.copy( this.arQuaternion );
		this.previewGroup.visible = this.hasHit;

		// Confirm / lock
		if ( this.hasHit && this._triggerPressedEdge() ) {

			this._confirmPlacement( frame, refSpace );

		}

	}

	// Surface search + manual thumbstick adjustment only — split out of
	// _updatePlacement() so updateExternalPlacement() below can drive a
	// caller's OWN object (the floating track/arena) with the exact same
	// "snap to the detected real surface, nudge with thumbsticks" behavior
	// the room-drive preview ring uses above, without also touching
	// previewGroup, this.placed, or onPlaced (all room-mode-specific).
	_updateHitTestPose( frame, refSpace, dt ) {

		// 1) Surface search: while no manual adjustment has happened yet,
		// keep the spawn marker snapped to the latest hit-test result.
		if ( this.hitTestSource ) {

			const results = frame.getHitTestResults( this.hitTestSource );

			if ( results.length > 0 ) {

				const pose = results[ 0 ].getPose( refSpace );

				if ( ! this.hasHit ) {

					// First surface found: face away from the player.
					const xrCam = this.renderer.xr.getCamera();
					this._camPos.setFromMatrixPosition( xrCam.matrixWorld );
					this._camForward.set( 0, 0, -1 ).transformDirection( xrCam.matrixWorld );
					const yaw = Math.atan2( this._camForward.x, this._camForward.z );
					this.arQuaternion.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), yaw );

				}

				this.arPosition.set(
					pose.transform.position.x,
					pose.transform.position.y,
					pose.transform.position.z
				);

				this.hasHit = true;

			}

		}

		// 2) Manual adjustment via thumbsticks (only meaningful once we have
		// an initial hit to adjust from).
		if ( this.hasHit ) {

			this._applyThumbstickAdjustment( Math.min( dt, 1 / 30 ) );

		}

	}

	// Public: hit-test-based placement for a caller with its OWN object to
	// position (the floating track/arena), instead of the generic ring/
	// arrow preview + this.placed/onPlaced flow used above for room-drive
	// mode. Call every frame while the caller's own "placing" phase is
	// active, and copy this.arPosition/this.arQuaternion onto the
	// caller's object each time (the same values _updatePlacement would
	// otherwise apply to previewGroup) — this keeps the track/arena glued
	// to whatever real surface was detected (a table, the floor, …)
	// instead of always spawning at a fixed distance in front of the
	// camera. Returns { hasHit, confirmEdge } — confirmEdge is true on the
	// exact frame a trigger press is detected while a surface is locked,
	// letting the caller decide what "confirm" means for it (here:
	// freeze the transform and build real physics), independent of
	// this.placed/onPlaced which stay room-mode-only.
	updateExternalPlacement( frame, dt ) {

		if ( ! this.session || ! frame ) return { hasHit: this.hasHit, confirmEdge: false };

		const refSpace = this.renderer.xr.getReferenceSpace();
		this._ensureHitTestSource();
		this._updateHitTestPose( frame, refSpace, dt );

		const confirmEdge = this.hasHit && this._triggerPressedEdge();

		return { hasHit: this.hasHit, confirmEdge };

	}

	_applyThumbstickAdjustment( dt ) {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const axesL = this.gamepads.left ? this.gamepads.left.axes : [];

		const moveX = this._axis( axesR, 2 );
		const moveY = this._axis( axesR, 3 );
		const rotX = this._axis( axesL, 2 );

		if ( moveX !== 0 || moveY !== 0 ) {

			const xrCam = this.renderer.xr.getCamera();
			const forward = this._camForward.set( 0, 0, -1 ).transformDirection( xrCam.matrixWorld );
			forward.y = 0;
			forward.normalize();
			const right = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) ).negate();

			this.arPosition
				.addScaledVector( right, moveX * MOVE_SPEED * dt )
				.addScaledVector( forward, - moveY * MOVE_SPEED * dt );

		}

		if ( rotX !== 0 ) {

			const deltaYaw = - rotX * ROTATE_SPEED * dt;
			const deltaQuat = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), deltaYaw );
			this.arQuaternion.premultiply( deltaQuat );

		}

	}

	_axis( axes, index ) {

		const v = axes && axes.length > index ? axes[ index ] : 0;
		return Math.abs( v ) > DEADZONE ? v : 0;

	}

	_triggerPressedEdge() {

		const rTrig = this.gamepads.right && this.gamepads.right.buttons[ 0 ] ? this.gamepads.right.buttons[ 0 ].pressed : false;
		const lTrig = this.gamepads.left && this.gamepads.left.buttons[ 0 ] ? this.gamepads.left.buttons[ 0 ].pressed : false;

		const rEdge = rTrig && ! this._prevTrigger.right;
		const lEdge = lTrig && ! this._prevTrigger.left;

		this._prevTrigger.right = rTrig;
		this._prevTrigger.left = lTrig;

		return rEdge || lEdge;

	}

	_confirmPlacement( frame, refSpace ) {

		this.placed = true;
		this.previewGroup.visible = false;

		if ( this.world ) {

			this._buildFreeRoamFloor();
			this._buildRoomFurnitureColliders( frame, refSpace );

		}

		if ( this.onPlaced ) this.onPlaced( this.getSpawnWorld() );

	}

	// Static floor collider for the car to drive on, plus solid perimeter
	// walls so the car bounces off the boundary instead of driving past
	// the edge into the void and falling. Always generous and fixed-size —
	// trusting plane-detection's reported floor size was causing an
	// undersized collider (a mislabeled or partially-scanned surface).
	_buildFreeRoamFloor() {

		// ─────────────────────────────────────────────────────────
		// ✏️ TO RESIZE THE AR PLAY AREA: change this one number (in
		// meters — half the width/depth, so 40 = an 80x80m square).
		const AR_FLOOR_HALF_SIZE = 500;
		// ─────────────────────────────────────────────────────────

		const halfW = AR_FLOOR_HALF_SIZE, halfD = AR_FLOOR_HALF_SIZE;
		const floorY = this.arPosition.y - 0.125;
		const cx = this.arPosition.x, cz = this.arPosition.z;

		rigidBody.create( this.world, {
			shape: box.create( { halfExtents: [ halfW, 0.01, halfD ] } ),
			motionType: MotionType.STATIC,
			objectLayer: this.world._OL_STATIC,
			position: [ cx, floorY, cz ],
			friction: 5.0,
			restitution: 0.0,
		} );

		const wallHalfHeight = 1.0;
		const wallThickness = 0.2;
		const wallY = floorY + wallHalfHeight;

		// North / South (along X, thin in Z)
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( this.world, {
				shape: box.create( { halfExtents: [ halfW, wallHalfHeight, wallThickness ] } ),
				motionType: MotionType.STATIC,
				objectLayer: this.world._OL_STATIC,
				position: [ cx, wallY, cz + sign * halfD ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

		// East / West (along Z, thin in X)
		for ( const sign of [ 1, -1 ] ) {

			rigidBody.create( this.world, {
				shape: box.create( { halfExtents: [ wallThickness, wallHalfHeight, halfD ] } ),
				motionType: MotionType.STATIC,
				objectLayer: this.world._OL_STATIC,
				position: [ cx + sign * halfW, wallY, cz ],
				friction: 0.2,
				restitution: 0.3,
			} );

		}

		// Visible floor grid: hidden by default, shown automatically by
		// main.js only while headlights are on — gives the light
		// something to visibly react to (real passthrough is just camera
		// video, unaffected by virtual lights) without a permanent
		// overlay cluttering the view the rest of the time.
		this._buildVisibleFloorGrid( AR_FLOOR_HALF_SIZE );

	}

	// A visible (semi-transparent) floor grid that responds to real
	// lighting — added specifically so the headlights have SOMETHING to
	// illuminate. Real-world passthrough is just camera video; virtual
	// lights have zero effect on it. Only virtual objects (like this
	// grid, or the car itself) can visibly react to our lights.
	_buildVisibleFloorGrid( size ) {

		// size = same half-size as the physics floor/walls, so the
		// surface always covers the full playable area — matters once
		// the car can be scaled up much larger than the default.
		//
		// No grid lines/texture on purpose — a visible pattern read as
		// an obvious overlay and broke the AR feel. Plain, very low
		// opacity, matte material instead: nearly invisible where unlit,
		// so only the patch the headlight beam actually hits stands out.
		const material = new THREE.MeshStandardMaterial( {
			color: 0x333333, transparent: true, opacity: 0.12,
			roughness: 1.0, metalness: 0, side: THREE.DoubleSide,
		} );

		const mesh = new THREE.Mesh( new THREE.PlaneGeometry( size * 2, size * 2 ), material );
		mesh.rotation.x = - Math.PI / 2;
		mesh.position.set( this.arPosition.x, this.arPosition.y - 0.02, this.arPosition.z );
		mesh.visible = false; // shown on demand via setFloorGridVisible()
		this.scene.add( mesh );
		this._visibleFloorGrid = mesh;

	}

	// Called by main.js to show the floor grid only while headlights
	// (or high beam) are on, so there's something visible for the light
	// to react to without a permanent overlay the rest of the time.
	setFloorGridVisible( visible ) {

		if ( this._visibleFloorGrid ) this._visibleFloorGrid.visible = visible;

	}

	// Best-effort real-world collision: uses Meta's WebXR mesh-detection
	// (requires the room's furniture to already be captured via Space Setup
	// on the headset) to add static, invisible colliders matching real
	// furniture, so the car actually bumps into the real couch/table.
	// Silently skips if the feature/browser/room data isn't available —
	// the game still works fine without it, just without real collision.
	_buildRoomFurnitureColliders( frame, refSpace ) {

		try {

			const meshes = frame.detectedMeshes;
			if ( ! meshes || meshes.size === 0 ) {

				console.log( '[ARManager] No room furniture meshes available (mesh-detection unsupported, or Space Setup furniture capture wasn\'t done on this headset).' );
				return;

			}

			const skipLabels = new Set( [ 'floor', 'ceiling', 'wall-face', 'invisible-wall-face', 'global-mesh', 'wall' ] );
			let count = 0;

			meshes.forEach( ( mesh ) => {

				const label = mesh.semanticLabel || '';
				if ( skipLabels.has( label ) ) return;

				const pose = frame.getPose( mesh.meshSpace, refSpace );
				if ( ! pose ) return;

				const bounds = this._computeVertexBounds( mesh.vertices );
				if ( ! bounds ) return;

				const poseQuat = new THREE.Quaternion(
					pose.transform.orientation.x, pose.transform.orientation.y,
					pose.transform.orientation.z, pose.transform.orientation.w
				);
				const centerLocal = new THREE.Vector3( bounds.cx, bounds.cy, bounds.cz ).applyQuaternion( poseQuat );
				const worldCenter = new THREE.Vector3(
					pose.transform.position.x, pose.transform.position.y, pose.transform.position.z
				).add( centerLocal );

				rigidBody.create( this.world, {
					shape: box.create( { halfExtents: [
						Math.max( bounds.hx, 0.02 ), Math.max( bounds.hy, 0.02 ), Math.max( bounds.hz, 0.02 )
					] } ),
					motionType: MotionType.STATIC,
					objectLayer: this.world._OL_STATIC,
					position: [ worldCenter.x, worldCenter.y, worldCenter.z ],
					quaternion: [ poseQuat.x, poseQuat.y, poseQuat.z, poseQuat.w ],
					friction: 0.8,
					restitution: 0.2,
				} );

				count ++;

			} );

			console.log( '[ARManager] Built', count, 'real-world furniture colliders.' );

		} catch ( e ) {

			console.warn( '[ARManager] Room furniture collision unavailable:', e );

		}

	}

	_computeVertexBounds( vertices ) {

		if ( ! vertices || vertices.length < 3 ) return null;

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

		for ( let i = 0; i < vertices.length; i += 3 ) {

			const x = vertices[ i ], y = vertices[ i + 1 ], z = vertices[ i + 2 ];
			if ( x < minX ) minX = x; if ( x > maxX ) maxX = x;
			if ( y < minY ) minY = y; if ( y > maxY ) maxY = y;
			if ( z < minZ ) minZ = z; if ( z > maxZ ) maxZ = z;

		}

		return {
			hx: ( maxX - minX ) / 2, hy: ( maxY - minY ) / 2, hz: ( maxZ - minZ ) / 2,
			cx: ( maxX + minX ) / 2, cy: ( maxY + minY ) / 2, cz: ( maxZ + minZ ) / 2,
		};

	}

	// ─── Public queries used by main.js after placement ──

	isPlaced() {

		return this.placed;

	}

	getSpawnWorld() {

		const yaw = new THREE.Euler().setFromQuaternion( this.arQuaternion, 'YXZ' ).y;
		// Match NORMAL mode's convention of spawning the sphere ~0.5m above
		// the floor (see Track.js computeSpawnPosition) rather than exactly
		// at the detected floor height, which left it embedded in the floor.
		const position = this.arPosition.clone();
		position.y += 0.5;

		return { position, angle: yaw };

	}

	// Driving input, once placed — analogous role to Controls.js, reusing
	// the exact same {x, z} contract Vehicle.update() already expects.
	getDriveInput() {

		const axesR = this.gamepads.right ? this.gamepads.right.axes : [];
		const x = this._axis( axesR, 2 );

		const rTrig = this.gamepads.right && this.gamepads.right.buttons[ 0 ] ? this.gamepads.right.buttons[ 0 ].value : 0;
		const rGrip = this.gamepads.right && this.gamepads.right.buttons[ 1 ] ? this.gamepads.right.buttons[ 1 ].value : 0;
		const lTrig = this.gamepads.left && this.gamepads.left.buttons[ 0 ] ? this.gamepads.left.buttons[ 0 ].value : 0;

		// Right trigger/grip = throttle, left trigger = brake/reverse.
		const z = Math.max( rTrig, rGrip ) - lTrig;

		return { x, z, touchActive: false };

	}

	// Left stick is unused while driving (steering/throttle/brake are on
	// the right stick + triggers) — free to repurpose for live resizing.
	// Returns a value in [-1, 1]; main.js turns this into a scale change.
	getScaleAdjustInput() {

		const left = this.gamepads.left;
		if ( ! left || ! left.axes ) return 0;

		// Different browser/firmware builds have occasionally reported the
		// thumbstick Y axis at index 1 instead of the xr-standard index 3 —
		// check both and use whichever has a real signal.
		const a3 = left.axes.length > 3 ? left.axes[ 3 ] : 0;
		const a1 = left.axes.length > 1 ? left.axes[ 1 ] : 0;
		const v = Math.abs( a3 ) > Math.abs( a1 ) ? a3 : a1;

		return Math.abs( v ) > 0.25 ? v : 0; // slightly larger deadzone than steering

	}

	// Left X/Y buttons (xr-standard indices 4/5) are completely unused
	// during driving — repurposed here for radio control. Returns
	// rising-edge booleans (true only on the frame the button was first
	// pressed), so main.js can react once per press rather than every frame.
	getRadioButtons() {

		const left = this.gamepads.left;
		const xBtn = left && left.buttons[ 4 ] ? left.buttons[ 4 ].pressed : false;
		const yBtn = left && left.buttons[ 5 ] ? left.buttons[ 5 ].pressed : false;

		const xEdge = xBtn && ! this._prevRadioButtons.x;
		const yEdge = yBtn && ! this._prevRadioButtons.y;

		this._prevRadioButtons.x = xBtn;
		this._prevRadioButtons.y = yBtn;

		return { next: xEdge, toggle: yEdge };

	}

	// Right thumbstick click (xr-standard index 3). Landed here after
	// left-hand attempts (grip, then left-stick-click) proved unreliable,
	// while every right-hand button tried has worked. Rising-edge only.
	getHeadlightToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 3 ] ? right.buttons[ 3 ].pressed : false;
		const edge = pressed && ! this._prevHeadlightButton;
		this._prevHeadlightButton = pressed;
		return edge;

	}

	// Right A/X button (xr-standard index 4) is unused elsewhere while
	// driving — repurposed for hazard-light toggle. Rising-edge only.
	getHazardToggle() {

		const right = this.gamepads.right;
		const pressed = right && right.buttons[ 4 ] ? right.buttons[ 4 ].pressed : false;
		const edge = pressed && ! this._prevHazardButton;
		this._prevHazardButton = pressed;
		return edge;

	}

	// Right B/Y button (xr-standard index 5) — high beam, held not
	// toggled, matching a real high-beam flasher stalk. Returns the raw
	// pressed state every frame (not edge-detected).
	getHighBeamHold() {

		const right = this.gamepads.right;
		return right && right.buttons[ 5 ] ? right.buttons[ 5 ].pressed : false;

	}

	// Left grip (xr-standard index 1) — completely unused elsewhere during
	// driving, repurposed for the horn. Held not toggled, like a real
	// horn button. Returns the raw pressed state every frame.
	// Left controller's physical Menu (☰) button — NOT part of the
	// standard xr-standard 0-5 button set, and most browsers reserve it
	// entirely for the system-level Quest menu, never exposing a press
	// to web content at all. This checks index 6 as a best-effort guess
	// in case a given browser does pass it through; if not, this simply
	// never returns true and the feature silently does nothing, rather
	// than breaking anything. Rising-edge only.
	getMenuButtonPress() {

		const left = this.gamepads.left;
		const pressed = left && left.buttons[ 6 ] ? left.buttons[ 6 ].pressed : false;
		const edge = pressed && ! this._prevMenuButton;
		this._prevMenuButton = pressed;
		return edge;

	}

	getHornHold() {

		const left = this.gamepads.left;
		return left && left.buttons[ 1 ] ? left.buttons[ 1 ].pressed : false;

	}

	// Left thumbstick click (xr-standard index 3) — unused elsewhere,
	// repurposed for the handbrake. Held not toggled, like a real
	// handbrake lever.
	getHandbrakeHold() {

		const left = this.gamepads.left;
		return left && left.buttons[ 3 ] ? left.buttons[ 3 ].pressed : false;

	}

	_onSessionEnd() {

		this.session = null;
		this.hitTestSource = null;
		this.hitTestSourceRequested = false;

		if ( this._savedBackground !== null ) this.scene.background = this._savedBackground;
		this.scene.fog = this._savedFog;

		this.previewGroup.visible = false;

	}

}
