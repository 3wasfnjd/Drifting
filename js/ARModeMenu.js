import * as THREE from 'three';

const MODES = [
	{ id: 'free', title: 'قيادة حرة', subtitle: 'تحرك بحرية في المساحة', badge: 'FREE', color: '#00d9b5' },
	{ id: 'track', title: 'مضمار AR', subtitle: 'مضمار سباق مصغّر', badge: 'TRACK', color: '#00aef3' },
	{ id: 'arena', title: 'حلبة الدرفت', subtitle: 'ساحة مفتوحة للتفحيط', badge: 'ARENA', color: '#ff7a1a' },
];

function roundedRect( ctx, x, y, width, height, radius ) {
	const r = Math.min( radius, width / 2, height / 2 );
	ctx.beginPath();
	ctx.moveTo( x + r, y );
	ctx.arcTo( x + width, y, x + width, y + height, r );
	ctx.arcTo( x + width, y + height, x, y + height, r );
	ctx.arcTo( x, y + height, x, y, r );
	ctx.arcTo( x, y, x + width, y, r );
	ctx.closePath();
}

function cardTexture( mode ) {
	const canvas = document.createElement( 'canvas' );
	canvas.width = 720;
	canvas.height = 420;
	const ctx = canvas.getContext( '2d' );
	ctx.clearRect( 0, 0, canvas.width, canvas.height );

	const gradient = ctx.createLinearGradient( 0, 0, canvas.width, canvas.height );
	gradient.addColorStop( 0, 'rgba(22,31,48,0.96)' );
	gradient.addColorStop( 1, 'rgba(6,10,17,0.96)' );
	roundedRect( ctx, 14, 14, canvas.width - 28, canvas.height - 28, 42 );
	ctx.fillStyle = gradient;
	ctx.fill();
	ctx.lineWidth = 6;
	ctx.strokeStyle = mode.color;
	ctx.globalAlpha = 0.88;
	ctx.stroke();
	ctx.globalAlpha = 1;
	ctx.textAlign = 'center';
	ctx.direction = 'rtl';
	ctx.fillStyle = mode.color;
	ctx.font = '700 28px sans-serif';
	ctx.fillText( mode.badge, canvas.width / 2, 78 );
	ctx.fillStyle = '#ffffff';
	ctx.font = '700 58px sans-serif';
	ctx.fillText( mode.title, canvas.width / 2, 190 );
	ctx.fillStyle = '#aebbd0';
	ctx.font = '34px sans-serif';
	ctx.fillText( mode.subtitle, canvas.width / 2, 258 );
	ctx.fillStyle = 'rgba(255,255,255,0.08)';
	roundedRect( ctx, 175, 310, 370, 62, 31 );
	ctx.fill();
	ctx.fillStyle = '#eef5ff';
	ctx.font = '700 26px sans-serif';
	ctx.fillText( 'الزناد للاختيار', canvas.width / 2, 351 );

	const texture = new THREE.CanvasTexture( canvas );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	texture.needsUpdate = true;
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

		// Cards float directly in AR; no dark backing panel.
		MODES.forEach( ( mode, index ) => {
			const material = new THREE.MeshBasicMaterial( {
				map: cardTexture( mode ), transparent: true, side: THREE.DoubleSide, depthWrite: false,
			} );
			const card = new THREE.Mesh( new THREE.PlaneGeometry( 0.62, 0.36 ), material );
			card.position.set( ( index - 1 ) * 0.70, 0, 0 );
			card.userData.arMode = mode.id;
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

	hide() { this.group.visible = false; }

	placeInFrontOf( camera ) {
		if ( this.placed ) return;
		camera.updateMatrixWorld( true );
		const position = new THREE.Vector3().setFromMatrixPosition( camera.matrixWorld );
		const quaternion = camera.getWorldQuaternion( new THREE.Quaternion() );
		const forward = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( quaternion );
		forward.y = 0;
		if ( forward.lengthSq() < 0.0001 ) forward.set( 0, 0, -1 );
		forward.normalize();

		// Place once in world space. The menu stays fixed when the headset moves.
		// Slightly below eye height gives a natural forward/down gaze.
		this.group.position.copy( position ).addScaledVector( forward, 2.15 );
		this.group.position.y -= 0.18;
		this.group.lookAt( position.x, this.group.position.y, position.z );
		this.group.rotateY( Math.PI );
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
			const target = card === hovered ? 1.06 : 1;
			card.scale.lerp( new THREE.Vector3( target, target, target ), 0.18 );
		}
		if ( ! anyPressed ) this.armed = true;
		return selectedMode;
	}
}
