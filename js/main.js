import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle, MAX_SPEED } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { DriftMarks } from './DriftMarks.js';
import { GameAudio } from './Audio.js';
import { LapTimer } from './LapTimer.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ColorMapGLTFLoader } from './Loader.js';


const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType, alpha: true } );
renderer.xr.enabled = true;

// Custom style to ensure WebXR buttons are visible on top of UI without overlapping
const xrBtnStyle = document.createElement( 'style' );
xrBtnStyle.textContent = `
	#ARButton, #VRButton {
		position: absolute !important;
		bottom: 20px !important;
		z-index: 10000 !important;
		padding: 12px 24px !important;
		font-size: 16px !important;
		font-weight: bold !important;
		border-radius: 30px !important;
		box-shadow: 0 4px 15px rgba(0,0,0,0.3) !important;
	}
	#ARButton {
		left: calc(50% - 90px) !important;
		transform: translateX(-50%) !important;
	}
	#VRButton {
		left: calc(50% + 90px) !important;
		transform: translateX(-50%) !important;
	}
`;
document.head.appendChild( xrBtnStyle );

renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

function setupDOM() {

	if ( ! document.body.contains( renderer.domElement ) ) {

		document.body.appendChild( renderer.domElement );

	}

	const arBtn = ARButton.createButton( renderer, {
		optionalFeatures: [ 'hit-test', 'local-floor', 'dom-overlay' ],
		domOverlay: { root: document.body }
	} );
	document.body.appendChild( arBtn );

	const vrBtn = VRButton.createButton( renderer );
	document.body.appendChild( vrBtn );

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

	buildTrack( scene, models, customCells );

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

	const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
	arGroup.add( vehicleGroup );

	dirLight.target = vehicleGroup;

	// AR Reticle for surface detection
	const reticleGeom = new THREE.RingGeometry( 0.15, 0.2, 32 ).rotateX( - Math.PI / 2 );
	const reticleMat = new THREE.MeshBasicMaterial( { color: 0x00ff00, side: THREE.DoubleSide } );
	const reticle = new THREE.Mesh( reticleGeom, reticleMat );
	reticle.matrixAutoUpdate = false;
	reticle.visible = false;
	scene.add( reticle );

	let hitTestSource = null;
	let hitTestSourceRequested = false;

	// Scale and Placement Controls for AR
	let arScale = 0.1;
	arGroup.scale.setScalar( 1.0 ); // Default 1.0 in standard mode

	// Add AR UI overlay for scaling and placing
	const arControlsDiv = document.createElement( 'div' );
	arControlsDiv.style.cssText = `
		position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
		display: none; gap: 10px; z-index: 999;
	`;
	arControlsDiv.innerHTML = `
		<button id="ar-place-btn" style="padding: 10px 16px; font-size: 14px; border-radius: 20px; border: none; background: rgba(0,255,100,0.85); color: #000; font-weight: bold;">Place Track</button>
		<button id="ar-scale-up" style="padding: 10px 16px; font-size: 14px; border-radius: 20px; border: none; background: rgba(255,255,255,0.85); font-weight: bold;">Scale +</button>
		<button id="ar-scale-down" style="padding: 10px 16px; font-size: 14px; border-radius: 20px; border: none; background: rgba(255,255,255,0.85); font-weight: bold;">Scale -</button>
	`;
	document.body.appendChild( arControlsDiv );

	document.getElementById( 'ar-place-btn' ).addEventListener( 'click', () => {

		if ( reticle.visible ) {

			arGroup.position.setFromMatrixPosition( reticle.matrix );

		}

	} );

	document.getElementById( 'ar-scale-up' ).addEventListener( 'click', () => {

		if ( renderer.xr.isPresenting ) {

			arScale = Math.min( arScale + 0.02, 0.5 );
			arGroup.scale.setScalar( arScale );

		}

	} );

	document.getElementById( 'ar-scale-down' ).addEventListener( 'click', () => {

		if ( renderer.xr.isPresenting ) {

			arScale = Math.max( arScale - 0.02, 0.02 );
			arGroup.scale.setScalar( arScale );

		}

	} );

	const cam = new Camera();
	scene.add( cam.debug );

	const controls = new Controls();

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

	let originalBackground = scene.background;
	let originalFog = scene.fog;

	renderer.xr.addEventListener( 'sessionstart', () => {

		scene.background = null;
		scene.fog = null;
		arGroup.scale.setScalar( arScale );
		arControlsDiv.style.display = 'flex';

	} );

	renderer.xr.addEventListener( 'sessionend', () => {

		scene.background = originalBackground;
		scene.fog = originalFog;
		arGroup.scale.setScalar( 1.0 );
		arGroup.position.set( 0, 0, 0 );
		arControlsDiv.style.display = 'none';
		hitTestSourceRequested = false;
		hitTestSource = null;
		reticle.visible = false;

	} );

	renderer.setAnimationLoop( ( timestamp, frame ) => {

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );

		if ( renderer.xr.isPresenting && frame ) {

			const session = renderer.xr.getSession();

			if ( ! hitTestSourceRequested ) {

				session.requestReferenceSpace( 'viewer' ).then( ( referenceSpace ) => {

					session.requestHitTestSource( { space: referenceSpace } ).then( ( source ) => {

						hitTestSource = source;

					} );

				} );

				session.addEventListener( 'end', () => {

					hitTestSourceRequested = false;
					hitTestSource = null;

				} );

				hitTestSourceRequested = true;

			}

			if ( hitTestSource ) {

				const referenceSpace = renderer.xr.getReferenceSpace();
				const hitTestResults = frame.getHitTestResults( hitTestSource );

				if ( hitTestResults.length > 0 ) {

					const hit = hitTestResults[ 0 ];
					const pose = hit.getPose( referenceSpace );

					reticle.visible = true;
					reticle.matrix.fromArray( pose.transform.matrix );

				} else {

					reticle.visible = false;

				}

			}

		}

		const input = controls.update();

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

		renderer.render( scene, renderer.xr.isPresenting ? renderer.xr.getCamera() : cam.camera );

	} );

}

init();
