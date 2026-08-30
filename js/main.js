import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, TRACK_CELLS } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { LapTimer } from './LapTimer.js';
import { ARManager } from './ARManager.js';
import { ColorMapGLTFLoader } from './Loader.js';
import { buildDriftArena, buildDriftArenaPhysics, DRIFT_ARENA_RADIUS } from './DriftArena.js';
import { ARModeMenu } from './ARModeMenu.js';

const pageParams = new URLSearchParams( window.location.search );
const requestedARMode = pageParams.get( 'arMode' );
const homeARHost = document.body.dataset.homeArHost === 'true';
const initialARMode = homeARHost ? 'menu' : ( [ 'free', 'track', 'arena' ].includes( requestedARMode ) ? requestedARMode : 'free' );
const isARExperience = homeARHost || pageParams.get( 'ar' ) === '1';
const AR_CONTENT_SCALE = 0.08;
const AR_VEHICLE_RADIUS = 0.5 * AR_CONTENT_SCALE;

let activeARMode = initialARMode;

const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, alpha: true } );
renderer.xr.enabled = true;

// Styling for the single AR entry button (driven by ARManager — there is no
// VR mode anymore, ARManager only implements immersive-ar free-roam driving).
const xrBtnStyle = document.createElement( 'style' );
xrBtnStyle.textContent = `
	#ARButton {
		position: absolute !important;
		bottom: 20px !important;
		left: 50% !important;
		transform: translateX(-50%) !important;
		z-index: 10000 !important;
		padding: 12px 24px !important;
		font-size: 16px !important;
		font-weight: bold !important;
		border-radius: 30px !important;
		border: none !important;
		background: rgba(0, 0, 0, 0.7) !important;
		color: #fff !important;
		box-shadow: 0 4px 15px rgba(0,0,0,0.3) !important;
		cursor: pointer !important;
		display: none;
	}
	#ARButton[data-supported="true"] { display: block !important; }
	#ARButton:disabled { opacity: 0.5 !important; cursor: default !important; }
`;
document.head.appendChild( xrBtnStyle );

renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// The EffectComposer (and its bloom pass) is created once track/camera setup
// finishes inside init(). Declared here so the resize handler below can reach it.
let composer = null;

// The ARManager instance (created once models/world are ready inside init())
// and the button that starts an AR session through it. Declared here so
// setupDOM(), which can run before init() finishes, can wire the click
// handler immediately and just no-op until arManager exists.
let arManager = null;
let arEnterBtn = null;
let arSessionPending = false;

async function enterAR() {

	if ( ! arManager || arSessionPending ) return;

	arSessionPending = true;
	arEnterBtn.disabled = true;
	arEnterBtn.textContent = 'STARTING AR…';

	try {

		await arManager.requestSession();

	} catch ( error ) {

		console.error( '[AR] Unable to start immersive-ar session:', error );
		arEnterBtn.textContent = 'ENTER AR';
		arEnterBtn.disabled = false;
		window.alert( 'AR could not start. Use a WebXR AR-compatible browser and allow the requested XR permissions.' );

	} finally {

		arSessionPending = false;

	}

}

window.startDriftingAR = enterAR;

function setupDOM() {

	if ( ! document.body.contains( renderer.domElement ) ) {

		document.body.appendChild( renderer.domElement );

	}

	arEnterBtn = document.createElement( 'button' );
	arEnterBtn.id = 'ARButton';
	arEnterBtn.textContent = 'ENTER AR';
	arEnterBtn.disabled = true; // enabled once arManager is ready (see init())
	arEnterBtn.addEventListener( 'click', () => {

		// Fired directly from a real click, so this carries the user-activation
		// flag WebXR requires to grant a session — unlike a synthetic .click().
		enterAR();

	} );
	document.body.appendChild( arEnterBtn );

	ARManager.isSupported().then( ( supported ) => {

		arEnterBtn.dataset.supported = supported && isARExperience && ! homeARHost ? 'true' : 'false';
		if ( ! supported && new URLSearchParams( window.location.search ).get( 'ar' ) === '1' ) {

			window.alert( 'Immersive AR is not supported by this browser or device.' );

		}

	} );

}

if ( document.readyState === 'loading' ) {

	window.addEventListener( 'DOMContentLoaded', setupDOM );

} else {

	setupDOM();

}

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 4096 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
dirLight.shadow.radius = 4;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 2 );
hemiLight.position.copy( dirLight.position )
scene.add( hemiLight );


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );
	if ( composer ) composer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new ColorMapGLTFLoader();

const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

const models = {};

async function loadModels() {

	const namesToLoad = isARExperience ? modelNames.filter( name => ! name.startsWith( 'decoration-' ) ) : modelNames;
	const promises = namesToLoad.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				const meshes = [];
				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;
						meshes.push( child );

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				if ( meshes.length === 1 ) {

					const mesh = meshes[ 0 ];
					mesh.removeFromParent();
					models[ name ] = mesh;

				} else {

					models[ name ] = gltf.scene;

				}

				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );

}

async function init() {

	registerAll();
	await loadModels();

	const mapParam = pageParams.get( 'map' );
	let customCells = null;
	let spawn = null;

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	// Compute track bounds and size physics/shadows to fit
	const bounds = computeTrackBounds( customCells );
	const arTrackBounds = computeTrackBounds( customCells || TRACK_CELLS );
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

	const trackGroup = buildTrack( scene, models, customCells, ! isARExperience );
	trackGroup.visible = ! isARExperience;
	if ( isARExperience ) trackGroup.scale.multiplyScalar( AR_CONTENT_SCALE );

	const driftArenaGroup = buildDriftArena( models );
	if ( isARExperience ) driftArenaGroup.scale.setScalar( AR_CONTENT_SCALE );
	scene.add( driftArenaGroup );

	// The baked probe grid is useful for the web track, but expensive and
	// invisible in passthrough AR. Skip it on the home AR host.
	if ( ! isARExperience ) {

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

	}

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

	const roadHalf = groundSize / 2;
	if ( ! isARExperience ) {

		buildWallColliders( world, null, customCells );
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
			motionType: MotionType.STATIC,
			objectLayer: OL_STATIC,
			position: [ bounds.centerX, - 0.125, bounds.centerZ ],
			friction: 5.0,
			restitution: 0.0,
		} );

	}

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null, isARExperience ? AR_VEHICLE_RADIUS : 0.5 );

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;
	vehicle.visualOffset = isARExperience ? AR_VEHICLE_RADIUS : 0.5;

	if ( spawn ) {

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

	const modeMenu = new ARModeMenu( scene );

	// Preserve each web-environment object's own visibility while AR is active.
	// Hiding on sessionstart ensures no track, decorations, NPC vehicles, or
	// baked probes appear even during the surface-placement phase.
	const webEnvironmentVisibility = new Map();
	renderer.xr.addEventListener( 'sessionstart', () => {

		toMove.forEach( ( object ) => {

			webEnvironmentVisibility.set( object, object.visible );
			object.visible = false;

		} );
		if ( activeARMode === 'menu' ) {

			modeMenu.show();
			arManager.setSelectionRaysVisible( true );

		}

	} );
	renderer.xr.addEventListener( 'sessionend', () => {

		toMove.forEach( ( object ) => {

			object.visible = webEnvironmentVisibility.get( object ) ?? true;

		} );
		webEnvironmentVisibility.clear();
		modeMenu.hide();
		arManager.setSelectionRaysVisible( false );
		if ( homeARHost ) {

			activeARMode = 'menu';
			arManager.buildFreeRoamFloor = false;
			arManager.setPlacementEnabled( false );
			window.setTimeout( () => window.location.reload(), 50 );

		}
		if ( arEnterBtn ) {

			arEnterBtn.textContent = 'ENTER AR';
			arEnterBtn.disabled = false;

		}

	} );

	let currentVehicleMesh = models[ 'vehicle-truck-yellow' ];
	let arVehicleScaleFactor = 1;
	let vehicleGroup = vehicle.init( currentVehicleMesh );
	if ( isARExperience ) vehicleGroup.scale.setScalar( AR_CONTENT_SCALE );
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
				if ( isARExperience ) vehicleGroup.scale.setScalar( AR_CONTENT_SCALE );
				arGroup.add( vehicleGroup );
				dirLight.target = vehicleGroup;

			}

		} );

	} );

	dirLight.target = vehicleGroup;

	// ARManager: free-roam AR mode. Placement (surface hit-testing and the
	// ring/arrow preview) is its responsibility — main.js only reacts once a spot
	// has been confirmed, via onPlaced. Created after the arGroup reparenting
	// above so its own objects (controllers, preview ring) stay direct
	// children of the scene rather than being swept into arGroup.
	arManager = new ARManager( {
		renderer,
		scene,
		buildFreeRoamFloor: activeARMode === 'free',
		placementEnabled: activeARMode !== 'menu',
		spawnHeight: isARExperience ? AR_VEHICLE_RADIUS : 0.5,
	} );
	arManager.setWorld( world );

	arManager.onPlaced = ( { position, angle } ) => {

		let vehiclePosition = position.clone();
		let vehicleAngle = angle;

		if ( activeARMode === 'track' ) {

			const offset = {
				x: position.x - arTrackBounds.centerX * AR_CONTENT_SCALE,
				y: position.y,
				z: position.z - arTrackBounds.centerZ * AR_CONTENT_SCALE,
				scale: AR_CONTENT_SCALE,
			};
			trackGroup.position.set( offset.x, position.y - 0.5 * 0.75 * AR_CONTENT_SCALE, offset.z );
			trackGroup.visible = true;
			buildWallColliders( world, null, customCells, offset );

			rigidBody.create( world, {
				shape: box.create( { halfExtents: [ roadHalf * AR_CONTENT_SCALE, 0.01 * AR_CONTENT_SCALE, roadHalf * AR_CONTENT_SCALE ] } ),
				motionType: MotionType.STATIC,
				objectLayer: OL_STATIC,
				position: [ position.x, position.y - 0.01 * AR_CONTENT_SCALE, position.z ],
				friction: 5.0,
				restitution: 0,
			} );

			const trackSpawn = spawn || computeSpawnPosition( TRACK_CELLS );
			vehiclePosition.set(
				trackSpawn.position[ 0 ] * AR_CONTENT_SCALE + offset.x,
				position.y + AR_VEHICLE_RADIUS,
				trackSpawn.position[ 2 ] * AR_CONTENT_SCALE + offset.z
			);
			vehicleAngle = trackSpawn.angle;

		} else if ( activeARMode === 'arena' ) {

			driftArenaGroup.position.set( position.x, position.y, position.z );
			driftArenaGroup.visible = true;
			buildDriftArenaPhysics( world, position, AR_CONTENT_SCALE );
			vehiclePosition.set(
				position.x,
				position.y + AR_VEHICLE_RADIUS,
				position.z + DRIFT_ARENA_RADIUS * AR_CONTENT_SCALE * 0.45
			);
			vehicleAngle = Math.PI;

		}

		rigidBody.setPosition( world, sphereBody, [ vehiclePosition.x, vehiclePosition.y, vehiclePosition.z ], false );
		rigidBody.setLinearVelocity( world, sphereBody, [ 0, 0, 0 ] );
		rigidBody.setAngularVelocity( world, sphereBody, [ 0, 0, 0 ] );

		vehicle.spherePos.copy( vehiclePosition );
		vehicle.spawnPos.copy( vehiclePosition );
		vehicle.spawnAngle = vehicleAngle;
		vehicle.sphereVel.set( 0, 0, 0 );
		vehicle.prevModelPos.set( vehiclePosition.x, vehiclePosition.y - ( isARExperience ? AR_VEHICLE_RADIUS : 0.5 ), vehiclePosition.z );
		vehicle.linearSpeed = 0;
		vehicle.angularSpeed = 0;
		vehicle.container.quaternion.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), vehicleAngle );

	};

	if ( arEnterBtn ) arEnterBtn.disabled = false;
	if ( homeARHost ) {

		const supported = await ARManager.isSupported();
		window.dispatchEvent( new CustomEvent( 'drifting-ar-ready', { detail: { supported } } ) );

	}

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


	const controls = new Controls();
	// The home page hosts the AR session, but must remain an ordinary clickable
	// menu until immersive AR starts. The full-screen touch steering layer would
	// otherwise sit above the menu and intercept every pointer interaction.
	if ( ! homeARHost ) controls.setupTouchUI();

	const particles = new SmokeTrails( scene, isARExperience ? {
		poolSize: 160,
		particlesPerEmit: 1,
		scale: AR_CONTENT_SCALE,
		maxLife: 1.1,
		emitInterval: 0.1,
	} : undefined );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	// Lap timing belongs to the standalone web game. Keeping it out of the home
	// AR host prevents its absolute-positioned HUD from overlapping the menu.
	const lapTimer = homeARHost ? null : new LapTimer( customCells, mapParam );

	const _forward = new THREE.Vector3();
	const _camLead = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const timer = new THREE.Timer();

	renderer.setAnimationLoop( ( timestamp, frame ) => {

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );

		const inAR = renderer.xr.isPresenting;

		if ( inAR && frame ) {

			if ( activeARMode === 'menu' ) {

				modeMenu.placeInFrontOf( renderer.xr.getCamera() );
				const selectedMode = modeMenu.update( arManager.controllers, arManager.gamepads );
				if ( selectedMode ) {

					activeARMode = selectedMode;
					modeMenu.hide();
					arManager.setSelectionRaysVisible( false );
					arManager.buildFreeRoamFloor = activeARMode === 'free';
					arManager.setPlacementEnabled( true );

				}

			}

			arManager.update( frame, dt );

		}

		// Keyboard/touch/gamepad while driving normally; ARManager's own
		// controller reading once a spot is confirmed; no input at all
		// during AR placement (car shouldn't drive off before it's placed).
		let input;
		if ( inAR ) {

			input = arManager.isPlaced() ? arManager.getDriveInput() : { x: 0, z: 0, touchActive: false };

		} else {

			input = controls.update();

		}

		if ( inAR && arManager.isPlaced() && activeARMode === 'free' ) {

			const scaleInput = arManager.getVehicleScaleInput();
			if ( scaleInput !== 0 ) {

				arVehicleScaleFactor = THREE.MathUtils.clamp( arVehicleScaleFactor + scaleInput * dt, 0.5, 2.5 );
				vehicleGroup.scale.setScalar( AR_CONTENT_SCALE * arVehicleScaleFactor );

			}

		}

		const simulationReady = ! isARExperience || ( inAR && arManager.isPlaced() );
		if ( simulationReady ) {

			updateWorld( world, contactListener, dt );

			// Tiny dynamic bodies can oscillate against equally tiny AR floor
			// colliders. Track and arena surfaces are flat, so keep the sphere's
			// centre exactly one radius above the placed surface while preserving
			// horizontal velocity and all wall collisions.
			if ( isARExperience && activeARMode !== 'free' ) {

				const bodyPosition = sphereBody.position;
				const bodyVelocity = sphereBody.motionProperties.linearVelocity;
				rigidBody.setPosition( world, sphereBody, [ bodyPosition[ 0 ], vehicle.spawnPos.y, bodyPosition[ 2 ] ], false );
				rigidBody.setLinearVelocity( world, sphereBody, [ bodyVelocity[ 0 ], 0, bodyVelocity[ 2 ] ] );

			}

			vehicle.update( dt, input );

		}

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			15,
			vehicle.spherePos.z - 5.3
		);

		const mv = vehicle.modelVelocity;
		_camLead.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion ).multiplyScalar( Math.sqrt( mv.x * mv.x + mv.z * mv.z ) );

		if ( ! renderer.xr.isPresenting ) {

			cam.update( dt, vehicle.spherePos, _camLead );

		}

		if ( simulationReady ) {

			particles.update( dt, vehicle );
			driftMarks.update( dt, vehicle );
			audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity );

			const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
			if ( lapTimer ) lapTimer.update( dt, vehicle.spherePos, hasInput );

		}


		if ( composer && ! renderer.xr.isPresenting ) {

			composer.render();

		} else {

			renderer.render( scene, renderer.xr.isPresenting ? renderer.xr.getCamera() : cam.camera );

		}

	} );

}

init();
