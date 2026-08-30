import * as THREE from 'three';

const MODES = [
	{ id: 'free', title: 'قيادة حرة', subtitle: 'السيارة داخل الغرفة', color: '#00d9b5' },
	{ id: 'track', title: 'مضمار AR', subtitle: 'مضمار سباق مصغّر', color: '#00aef3' },
	{ id: 'arena', title: 'حلبة الدرفت', subtitle: 'ساحة دائرية مضاءة', color: '#ff6a00' },
];

function cardTexture( mode ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 768;
	canvas.height = 460;
	const ctx = canvas.getContext( '2d' );

	const gradient = ctx.createLinearGradient( 0, 0, canvas.width, canvas.height );
	gradient.addColorStop( 0, '#172238' );
	gradient.addColorStop( 1, '#070b13' );
	ctx.fillStyle = gradient;
	ctx.fillRect( 0, 0, canvas.width, canvas.height );

	ctx.strokeStyle = mode.color;
	ctx.lineWidth = 14;
	ctx.strokeRect( 12, 12, canvas.width - 24, canvas.height - 24 );

	ctx.fillStyle = mode.color;
	ctx.beginPath();
	ctx.arc( canvas.width / 2, 118, 52, 0, Math.PI * 2 );
	ctx.fill();

	ctx.textAlign = 'center';
	ctx.direction = 'rtl';
	ctx.fillStyle = '#ffffff';
	ctx.font = '700 62px sans-serif';
	ctx.fillText( mode.title, canvas.width / 2, 260 );
	ctx.fillStyle = '#b9c7dc';
	ctx.font = '38px sans-serif';
	ctx.fillText( mode.subtitle, canvas.width / 2, 335 );
	ctx.fillStyle = mode.color;
	ctx.font = '700 30px sans-serif';
	ctx.fillText( 'اضغط الزناد للاختيار', canvas.width / 2, 405 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	return texture;

}

export class ARModeMenu {

	constructor( scene ) {

		this.group = new THREE.Group();
		this.group.name = 'ar-mode-menu';
		this.group.visible = false;
		this.cards = [];
		this.placed = false;
		this.previousPressed = { left: false, right: false };
		this.armed = false;
		this.raycaster = new THREE.Raycaster();
		this.rayOrigin = new THREE.Vector3();
		this.rayDirection = new THREE.Vector3();
		this.controllerQuaternion = new THREE.Quaternion();

		const panel = new THREE.Mesh(
			new THREE.PlaneGeometry( 2.85, 1.18 ),
			new THREE.MeshBasicMaterial( { color: 0x050812, transparent: true, opacity: 0.84, side: THREE.DoubleSide } )
		);
		panel.position.z = -0.035;
		this.group.add( panel );

		MODES.forEach( ( mode, index ) => {

			const material = new THREE.MeshBasicMaterial( { map: cardTexture( mode ), side: THREE.DoubleSide } );
			const card = new THREE.Mesh( new THREE.PlaneGeometry( 0.82, 0.52 ), material );
			card.position.set( ( index - 1 ) * 0.92, -0.04, 0 );
			card.userData.arMode = mode.id;
			card.userData.baseScale = 1;
			this.cards.push( card );
			this.group.add( card );

		} );

		scene.add( this.group );

	}

	show() {

		this.group.visible = true;
		this.placed = false;
		this.previousPressed.left = false;
		this.previousPressed.right = false;
		this.armed = false;

	}

	hide() {

		this.group.visible = false;

	}

	placeInFrontOf( camera ) {

		if ( this.placed ) return;
		camera.updateMatrixWorld( true );
		const position = new THREE.Vector3().setFromMatrixPosition( camera.matrixWorld );
		const quaternion = camera.getWorldQuaternion( new THREE.Quaternion() );
		const forward = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( quaternion );

		this.group.position.copy( position ).addScaledVector( forward, 1.65 );
		this.group.quaternion.copy( quaternion );
		this.placed = true;

	}

	update( controllers, gamepads ) {

		if ( ! this.group.visible ) return null;

		let hovered = null;
		let anyPressed = false;
		let selectedMode = null;
		for ( const hand of [ 'left', 'right' ] ) {

			const controller = controllers[ hand ];
			if ( ! controller ) continue;
			controller.updateMatrixWorld( true );
			this.rayOrigin.setFromMatrixPosition( controller.matrixWorld );
			controller.getWorldQuaternion( this.controllerQuaternion );
			this.rayDirection.set( 0, 0, -1 ).applyQuaternion( this.controllerQuaternion ).normalize();
			this.raycaster.set( this.rayOrigin, this.rayDirection );
			const hit = this.raycaster.intersectObjects( this.cards, false )[ 0 ];
			if ( hit ) hovered = hit.object;

			const pressed = Boolean( gamepads[ hand ]?.buttons?.[ 0 ]?.pressed );
			anyPressed ||= pressed;
			const edge = pressed && ! this.previousPressed[ hand ];
			this.previousPressed[ hand ] = pressed;
			if ( this.armed && edge && hit ) selectedMode = hit.object.userData.arMode;

		}

		for ( const card of this.cards ) {

			const target = card === hovered ? 1.1 : 1;
			card.scale.lerp( new THREE.Vector3( target, target, target ), 0.22 );

		}

		if ( ! anyPressed ) this.armed = true;

		return selectedMode;

	}

}
