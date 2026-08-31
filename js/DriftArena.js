import * as THREE from 'three';
import { rigidBody, box, MotionType } from 'crashcat';

export const DRIFT_ARENA_RADIUS = 40;

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
	const curbYellow = new THREE.MeshStandardMaterial( { color: 0xffd400, roughness: 0.68 } );
	const metal = new THREE.MeshStandardMaterial( { color: 0x303640, roughness: 0.55, metalness: 0.45 } );
	const tireMat = new THREE.MeshStandardMaterial( { color: 0x090a0c, roughness: 0.92 } );

	const floor = mesh( new THREE.CylinderGeometry( DRIFT_ARENA_RADIUS, DRIFT_ARENA_RADIUS, 0.18, 96 ), asphalt, group, [ 0, -0.09, 0 ] );
	floor.castShadow = false;

	const ringSegments = 48;
	// Use a slightly shortened chord so adjacent alternating blocks never
	// overlap and flicker at their shared edges.
	const barrierLength = 2 * DRIFT_ARENA_RADIUS * Math.sin( Math.PI / ringSegments ) * 0.96;
	for ( let i = 0; i < ringSegments; i ++ ) {

		const angle = i / ringSegments * Math.PI * 2;
		const barrier = mesh(
			new THREE.BoxGeometry( barrierLength, 0.65, 0.42 ),
			i % 2 === 0 ? curbYellow : curbDark,
			group,
			[ Math.cos( angle ) * DRIFT_ARENA_RADIUS, 0.32, Math.sin( angle ) * DRIFT_ARENA_RADIUS ]
		);
		barrier.rotation.y = - angle - Math.PI / 2;

	}

	// Keep floodlights close to the arena wall so the drift area stays open.
	const lampHousing = new THREE.MeshStandardMaterial( { color: 0xd7dce2, roughness: 0.72, metalness: 0.12 } );
	const floodlightRadius = DRIFT_ARENA_RADIUS - 3.2;
	for ( let i = 0; i < 4; i ++ ) {

		const angle = Math.PI / 4 + i * Math.PI / 2;
		const x = Math.cos( angle ) * floodlightRadius;
		const z = Math.sin( angle ) * floodlightRadius;
		const tower = new THREE.Group();
		tower.position.set( x, 0, z );
		tower.rotation.y = - angle - Math.PI / 2;
		group.add( tower );

		mesh( new THREE.CylinderGeometry( 0.13, 0.2, 5.8, 8 ), metal, tower, [ 0, 2.9, 0 ] );

		for ( let level = 0; level < 3; level ++ ) {

			const tyre = mesh( new THREE.TorusGeometry( 0.48, 0.18, 10, 24 ), tireMat, tower, [ 0, 0.2 + level * 0.28, 0 ] );
			tyre.rotation.x = Math.PI / 2;

		}
		mesh( new THREE.BoxGeometry( 2.8, 0.12, 0.12 ), metal, tower, [ 0, 5.6, 0 ] );
		mesh( new THREE.BoxGeometry( 2.5, 1.15, 0.12 ), metal, tower, [ 0, 5.95, 0 ] );

		for ( let row = 0; row < 2; row ++ ) {

			for ( let column = 0; column < 5; column ++ ) {

				mesh(
					new THREE.BoxGeometry( 0.38, 0.38, 0.16 ),
					lampHousing,
					tower,
					[ ( column - 2 ) * 0.47, 5.72 + row * 0.48, 0.12 ]
				);

			}

		}

	}

	// Parked display cars sit along the back perimeter instead of the center.
	const parkedZ = - ( DRIFT_ARENA_RADIUS - 4.0 );
	const parked = [
		[ 'vehicle-truck-green', -12, 0, parkedZ, 0.18 ],
		[ 'vehicle-truck-purple', 0, 0, parkedZ - 0.4, 0 ],
		[ 'vehicle-truck-red', 12, 0, parkedZ, -0.18 ],
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

export function buildDriftArenaPhysics( world, center, scale = 1 ) {

	const radius = DRIFT_ARENA_RADIUS * scale;

	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ radius, 0.01 * scale, radius ] } ),
		motionType: MotionType.STATIC,
		objectLayer: world._OL_STATIC,
		position: [ center.x, center.y - 0.01 * scale, center.z ],
		friction: 5.0,
		restitution: 0,
	} );

	const segments = 48;
	// Match the visible barrier gaps so neighbouring colliders do not overlap.
	const halfLength = radius * Math.sin( Math.PI / segments ) * 0.96;
	for ( let i = 0; i < segments; i ++ ) {

		const angle = i / segments * Math.PI * 2;
		rigidBody.create( world, {
			shape: box.create( { halfExtents: [ halfLength, 0.55 * scale, 0.3 * scale ] } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: [
				center.x + Math.cos( angle ) * radius,
				center.y + 0.55 * scale,
				center.z + Math.sin( angle ) * radius,
			],
			quaternion: [
				0,
				Math.sin( ( - angle - Math.PI / 2 ) / 2 ),
				0,
				Math.cos( ( - angle - Math.PI / 2 ) / 2 ),
			],
			friction: 0.2,
			restitution: 0.25,
		} );

	}

}
