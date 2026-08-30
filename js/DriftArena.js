import * as THREE from 'three';
import { rigidBody, box, MotionType } from 'crashcat';

export const DRIFT_ARENA_RADIUS = 18;

function mesh( geometry, material, parent, position = null ) {

	const object = new THREE.Mesh( geometry, material );
	if ( position ) object.position.set( ...position );
	object.castShadow = true;
	object.receiveShadow = true;
	parent.add( object );
	return object;

}

export function buildDriftArena( models ) {

	const group = new THREE.Group();
	group.name = 'ar-drift-arena';
	group.visible = false;

	const asphalt = new THREE.MeshStandardMaterial( { color: 0x252931, roughness: 0.94, metalness: 0.02 } );
	const curbDark = new THREE.MeshStandardMaterial( { color: 0x17191e, roughness: 0.8 } );
	const curbOrange = new THREE.MeshStandardMaterial( { color: 0xff6a00, roughness: 0.65 } );
	const metal = new THREE.MeshStandardMaterial( { color: 0x303640, roughness: 0.55, metalness: 0.45 } );
	const tireMat = new THREE.MeshStandardMaterial( { color: 0x090a0c, roughness: 0.92 } );

	const floor = mesh( new THREE.CylinderGeometry( DRIFT_ARENA_RADIUS, DRIFT_ARENA_RADIUS, 0.18, 96 ), asphalt, group, [ 0, -0.09, 0 ] );
	floor.castShadow = false;

	const ringSegments = 48;
	for ( let i = 0; i < ringSegments; i ++ ) {

		const angle = i / ringSegments * Math.PI * 2;
		const barrier = mesh(
			new THREE.BoxGeometry( 2.45, 0.65, 0.42 ),
			i % 2 === 0 ? curbOrange : curbDark,
			group,
			[ Math.cos( angle ) * DRIFT_ARENA_RADIUS, 0.32, Math.sin( angle ) * DRIFT_ARENA_RADIUS ]
		);
		barrier.rotation.y = - angle;

	}

	// Central tyre stacks leave a broad circular drift lane around them.
	for ( let stack = 0; stack < 5; stack ++ ) {

		const angle = stack / 5 * Math.PI * 2;
		for ( let level = 0; level < 3; level ++ ) {

			const tyre = mesh(
				new THREE.TorusGeometry( 0.48, 0.18, 10, 24 ), tireMat, group,
				[ Math.cos( angle ) * 2.2, 0.2 + level * 0.28, Math.sin( angle ) * 2.2 ]
			);
			tyre.rotation.x = Math.PI / 2;

		}

	}

	// Four floodlight towers with emissive lamps and real spotlights.
	const towerColors = [ 0x00d8ff, 0xff5c8a, 0xffb000, 0x8b5cff ];
	for ( let i = 0; i < 4; i ++ ) {

		const angle = Math.PI / 4 + i * Math.PI / 2;
		const x = Math.cos( angle ) * 14.5;
		const z = Math.sin( angle ) * 14.5;
		mesh( new THREE.CylinderGeometry( 0.13, 0.2, 5.8, 8 ), metal, group, [ x, 2.9, z ] );

		const lampMat = new THREE.MeshStandardMaterial( {
			color: towerColors[ i ], emissive: towerColors[ i ], emissiveIntensity: 4,
		} );
		const lamp = mesh( new THREE.BoxGeometry( 1.35, 0.45, 0.28 ), lampMat, group, [ x, 5.65, z ] );
		lamp.lookAt( 0, 1.5, 0 );

		const light = new THREE.SpotLight( towerColors[ i ], 28, 34, Math.PI / 5, 0.55, 1.3 );
		light.position.set( x, 5.5, z );
		light.target.position.set( 0, 0, 0 );
		light.castShadow = false;
		group.add( light, light.target );

	}

	// Parked display cars use models already shipped with the game.
	const parked = [
		[ 'vehicle-truck-green', -10, 0, -12, 0.55 ],
		[ 'vehicle-truck-purple', 0, 0, -15, 0 ],
		[ 'vehicle-truck-red', 10, 0, -12, -0.55 ],
	];
	for ( const [ key, x, y, z, rotation ] of parked ) {

		const source = models[ key ];
		if ( ! source ) continue;
		const car = source.clone();
		car.position.set( x, y, z );
		car.rotation.y = rotation;
		car.traverse( child => {

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;

			}

		} );
		group.add( car );

	}

	return group;

}

export function buildDriftArenaPhysics( world, center ) {

	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ DRIFT_ARENA_RADIUS, 0.01, DRIFT_ARENA_RADIUS ] } ),
		motionType: MotionType.STATIC,
		objectLayer: world._OL_STATIC,
		position: [ center.x, center.y - 0.01, center.z ],
		friction: 5.0,
		restitution: 0,
	} );

	const segments = 48;
	const halfLength = DRIFT_ARENA_RADIUS * Math.PI / segments;
	for ( let i = 0; i < segments; i ++ ) {

		const angle = i / segments * Math.PI * 2;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ halfLength, 0.55, 0.3 ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [
				center.x + Math.cos( angle ) * DRIFT_ARENA_RADIUS,
				center.y + 0.55,
				center.z + Math.sin( angle ) * DRIFT_ARENA_RADIUS,
			],
			quaternion: [ 0, Math.sin( - angle / 2 ), 0, Math.cos( - angle / 2 ) ],
			friction: 0.2,
			restitution: 0.25,
		} );

	}

}
