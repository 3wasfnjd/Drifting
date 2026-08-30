diff --git a/js/main.js b/js/main.js
index 29ca56a1a5306521d14d9acfd225d9b3ad6e4807..c52069e062d4ed2a060cac6414bb2ee06cceccf2 100644
--- a/js/main.js
+++ b/js/main.js
@@ -1,31 +1,30 @@
 import * as THREE from 'three';
 import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
 import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
 import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
 import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
-import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
 import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
 import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
 import { Vehicle, MAX_SPEED } from './Vehicle.js';
 import { Camera } from './Camera.js';
 import { Controls } from './Controls.js';
 import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds } from './Track.js';
 import { buildWallColliders, createSphereBody } from './Physics.js';
 import { SmokeTrails } from './Particles.js';
 import { DriftMarks } from './DriftMarks.js';
 import { GameAudio } from './Audio.js';
 import { LapTimer } from './LapTimer.js';
 import { ARManager } from './ARManager.js';
 import { ColorMapGLTFLoader } from './Loader.js';
 
 
 const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, alpha: true } );
 renderer.xr.enabled = true;
 
 // Styling for the single AR entry button (driven by ARManager — there is no
 // VR mode anymore, ARManager only implements immersive-ar free-roam driving).
 const xrBtnStyle = document.createElement( 'style' );
 xrBtnStyle.textContent = `
 	#ARButton {
 		position: absolute !important;
 		bottom: 20px !important;
@@ -206,82 +205,73 @@ async function init() {
 
 		} catch ( e ) {
 
 			console.warn( 'Invalid map parameter, using default track' );
 
 		}
 
 	}
 
 	// Compute track bounds and size physics/shadows to fit
 	const bounds = computeTrackBounds( customCells );
 	const hw = bounds.halfWidth;
 	const hd = bounds.halfDepth;
 	const groundSize = Math.max( hw, hd ) * 2 + 20;
 
 	const shadowExtent = Math.max( hw, hd ) + 10;
 	dirLight.shadow.camera.left = - shadowExtent;
 	dirLight.shadow.camera.right = shadowExtent;
 	dirLight.shadow.camera.top = shadowExtent;
 	dirLight.shadow.camera.bottom = - shadowExtent;
 	dirLight.shadow.camera.updateProjectionMatrix();
 
 	scene.fog.near = groundSize * 0.4;
 	scene.fog.far = groundSize * 0.8;
 
-	const sceneChildCountBeforeTrack = scene.children.length;
 	buildTrack( scene, models, customCells );
-	// buildTrack()'s first scene.add() call is the track group itself
-	// (decorations/NPC trucks are added after it) — keep a handle on it so
-	// it can be hidden during ARManager's free-roam AR (no visual track there).
-	const trackGroup = scene.children[ sceneChildCountBeforeTrack ];
 
 	// Probes
 
 	const probeHeight = 6;
 	try {
 
 		const probes = new LightProbeGrid(
 			hw * 2, probeHeight, hd * 2,
 			Math.max( 4, Math.round( hw / 4 ) ),
 			2,
 			Math.max( 4, Math.round( hd / 4 ) ),
 		);
 		probes.position.set( bounds.centerX, probeHeight / 2, bounds.centerZ );
 		probes.bake( renderer, scene, { cubemapSize: 32, near: 0.1, far: groundSize } );
 		scene.add( probes );
 
 	} catch ( e ) {
 
 		console.warn( 'LightProbeGrid bake skipped:', e );
 
 	}
 
-	// scene.add( new LightProbeGridHelper( probes, 0.5 ) );
-
-	//
-
 	const worldSettings = createWorldSettings();
 	worldSettings.gravity = [ 0, - 9.81, 0 ];
 
 	const BPL_MOVING = addBroadphaseLayer( worldSettings );
 	const BPL_STATIC = addBroadphaseLayer( worldSettings );
 	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
 	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );
 
 	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
 	enableCollision( worldSettings, OL_MOVING, OL_MOVING );
 
 	const world = createWorld( worldSettings );
 	world._OL_MOVING = OL_MOVING;
 	world._OL_STATIC = OL_STATIC;
 
 	buildWallColliders( world, null, customCells );
 
 	const roadHalf = groundSize / 2;
 	rigidBody.create( world, {
 		shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
 		motionType: MotionType.STATIC,
 		objectLayer: OL_STATIC,
 		position: [ bounds.centerX, - 0.125, bounds.centerZ ],
 		friction: 5.0,
 		restitution: 0.0,
@@ -298,114 +288,127 @@ async function init() {
 		const [ sx, sy, sz ] = spawn.position;
 		vehicle.spawnPos.set( sx, sy, sz );
 		vehicle.spawnAngle = spawn.angle;
 		vehicle.spherePos.set( sx, sy, sz );
 		vehicle.prevModelPos.set( sx, 0, sz );
 		vehicle.container.rotation.y = spawn.angle;
 
 	}
 
 	const arGroup = new THREE.Group();
 	scene.add( arGroup );
 
 	// Move track objects to arGroup
 	const toMove = [];
 	scene.children.forEach( ( child ) => {
 
 		if ( child !== dirLight && child !== hemiLight && child !== arGroup ) {
 
 			toMove.push( child );
 
 		}
 
 	} );
 	toMove.forEach( ( child ) => arGroup.add( child ) );
 
+	// Preserve each web-environment object's own visibility while AR is active.
+	// Hiding on sessionstart ensures no track, decorations, NPC vehicles, or
+	// baked probes appear even during the surface-placement phase.
+	const webEnvironmentVisibility = new Map();
+	renderer.xr.addEventListener( 'sessionstart', () => {
+
+		toMove.forEach( ( object ) => {
+
+			webEnvironmentVisibility.set( object, object.visible );
+			object.visible = false;
+
+		} );
+
+	} );
+	renderer.xr.addEventListener( 'sessionend', () => {
+
+		toMove.forEach( ( object ) => {
+
+			object.visible = webEnvironmentVisibility.get( object ) ?? true;
+
+		} );
+		webEnvironmentVisibility.clear();
+
+	} );
+
 	let currentVehicleMesh = models[ 'vehicle-truck-yellow' ];
 	let vehicleGroup = vehicle.init( currentVehicleMesh );
 	arGroup.add( vehicleGroup );
 
 	// Handle Car Selector UI Cards
 	document.querySelectorAll( '.car-card' ).forEach( ( card ) => {
 
 		card.addEventListener( 'click', () => {
 
 			document.querySelectorAll( '.car-card' ).forEach( c => c.classList.remove( 'active' ) );
 			card.classList.add( 'active' );
 
 			const modelName = card.getAttribute( 'data-model' );
 
 			if ( models[ modelName ] ) {
 
 				arGroup.remove( vehicleGroup );
 				vehicleGroup = vehicle.init( models[ modelName ] );
 				arGroup.add( vehicleGroup );
 				dirLight.target = vehicleGroup;
 
 			}
 
 		} );
 
 	} );
 
 	dirLight.target = vehicleGroup;
 
-	// ARManager: free-roam AR mode. Placement (surface hit-testing, the
-	// ring/arrow preview, trigger-to-confirm) and room-furniture collision
-	// are entirely its own responsibility — main.js only reacts once a spot
+	// ARManager: free-roam AR mode. Placement (surface hit-testing and the
+	// ring/arrow preview) is its responsibility — main.js only reacts once a spot
 	// has been confirmed, via onPlaced. Created after the arGroup reparenting
 	// above so its own objects (controllers, preview ring) stay direct
 	// children of the scene rather than being swept into arGroup.
-	arManager = new ARManager( { renderer, scene, models } );
+	arManager = new ARManager( { renderer, scene } );
 	arManager.setWorld( world );
 
 	arManager.onPlaced = ( { position, angle } ) => {
 
-		trackGroup.visible = false;
-
 		rigidBody.setPosition( world, sphereBody, [ position.x, position.y, position.z ], false );
 		rigidBody.setLinearVelocity( world, sphereBody, [ 0, 0, 0 ] );
 		rigidBody.setAngularVelocity( world, sphereBody, [ 0, 0, 0 ] );
 
 		vehicle.spherePos.copy( position );
 		vehicle.sphereVel.set( 0, 0, 0 );
 		vehicle.prevModelPos.set( position.x, position.y - 0.5, position.z );
 		vehicle.linearSpeed = 0;
 		vehicle.angularSpeed = 0;
 		vehicle.container.quaternion.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), angle );
 
 	};
 
-	// Track meshes come back once the player leaves the AR session (ARManager
-	// itself restores scene.background/fog; this only needs to undo the line
-	// above).
-	renderer.xr.addEventListener( 'sessionend', () => {
-
-		trackGroup.visible = true;
-
-	} );
-
 	if ( arEnterBtn ) arEnterBtn.disabled = false;
 
 	const cam = new Camera();
 	scene.add( cam.debug );
 
 	try {
 
 		composer = new EffectComposer( renderer );
 		const renderPass = new RenderPass( scene, cam.camera );
 		composer.addPass( renderPass );
 
 		const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ), 0.02, 0.02, 0.5 );
 		composer.addPass( bloomPass );
 
 	} catch ( e ) {
 
 		console.warn( 'EffectComposer setup skipped:', e );
 
 	}
 
 	const orbitControls = new OrbitControls( cam.camera, renderer.domElement );
 	orbitControls.enableDamping = true;
 	orbitControls.dampingFactor = 0.05;
 	orbitControls.maxPolarAngle = Math.PI / 2 - 0.05;
 	orbitControls.minDistance = 3;
