import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
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
		if ( arManager ) arManager.requestSession();

	} );
	document.body.appendChild( arEnterBtn );

	ARManager.isSupported().then( ( supported ) => {

		arEnterBtn.dataset.supported = supported ? 'true' : 'false';

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

	const promises = modelNames.map( ( name ) =>
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

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
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

	const sceneChildCountBeforeTrack = scene.children.length;
	buildTrack( scene, models, customCells );
	// buildTrack()'s first scene.add() call is the track group itself
	// (decorations/NPC trucks are added after it) — keep a handle on it so
	// it can be hidden during ARManager's free-roam AR (no visual track there).
	const trackGroup = scene.children[ sceneChildCountBeforeTrack ];

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

	// scene.add( new LightProbeGridHelper( probes, 0.5 ) );

	//

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
	} );

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;

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

	// ARManager: free-roam AR mode. Placement (surface hit-testing, the
	// ring/arrow preview, trigger-to-confirm) and room-furniture collision
	// are entirely its own responsibility — main.js only reacts once a spot
	// has been confirmed, via onPlaced. Created after the arGroup reparenting
	// above so its own objects (controllers, preview ring) stay direct
	// children of the scene rather than being swept into arGroup.
	arManager = new ARManager( { renderer, scene, models } );
	arManager.setWorld( world );

	arManager.onPlaced = ( { position, angle } ) => {

		trackGroup.visible = false;

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

	// Track meshes come back once the player leaves the AR session (ARManager
	// itself restores scene.background/fog; this only needs to undo the line
	// above).
	renderer.xr.addEventListener( 'sessionend', () => {

		trackGroup.visible = true;

	} );

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
	orbitControls.maxDistance = 25;

	const controls = new Controls();
	controls.setupTouchUI();

	const particles = new SmokeTrails( scene );
	const driftMarks = new DriftMarks( scene, mapParam );

	const audio = new GameAudio();
	audio.init( cam.camera, vehicleGroup );

	const lapTimer = new LapTimer( customCells, mapParam );

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

		if ( inAR && frame ) arManager.update( frame, dt );

		// Keyboard/touch/gamepad while driving normally; ARManager's own
		// controller reading once a spot is confirmed; no input at all
		// during AR placement (car shouldn't drive off before it's placed).
		let input;
		if ( inAR ) {

			input = arManager.isPlaced() ? arManager.getDriveInput() : { x: 0, z: 0, touchActive: false };

		} else {

			input = controls.update();

		}

		updateWorld( world, contactListener, dt );

		vehicle.update( dt, input );

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

		particles.update( dt, vehicle );
		driftMarks.update( dt, vehicle );
		audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity );

		const hasInput = input.touchActive || Math.abs( input.x ) > 0.05 || Math.abs( input.z ) > 0.05;
		lapTimer.update( dt, vehicle.spherePos, hasInput );

		if ( orbitControls ) orbitControls.update();

		if ( composer && ! renderer.xr.isPresenting ) {

			composer.render();

		} else {

			renderer.render( scene, renderer.xr.isPresenting ? renderer.xr.getCamera() : cam.camera );

		}

	} );

}

init();
