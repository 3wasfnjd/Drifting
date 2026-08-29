export class Controls {

	constructor() {

		this.keys = {};
		this.x = 0;
		this.z = 0;

		// Touch state & UI buttons state
		this.touchActive = false;
		this.touchDirX = 0;
		this.touchDirY = 0;
		this.steerPointerId = null;
		this.steerStartX = 0;
		this.steerStartY = 0;

		this.btnUp = false;
		this.btnDown = false;
		this.btnLeft = false;
		this.btnRight = false;

		window.addEventListener( 'keydown', ( e ) => this.keys[ e.code ] = true );
		window.addEventListener( 'keyup', ( e ) => this.keys[ e.code ] = false );

		if ( document.body ) {

			this.setupTouchUI();

		} else {

			window.addEventListener( 'DOMContentLoaded', () => this.setupTouchUI() );

		}

	}

	setupTouchUI() {

		const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

		const css = document.createElement( 'style' );
		css.textContent = `
			.touch-controls { position: absolute; inset: 0; pointer-events: none; z-index: 100; }
			.steer-zone { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }
			.steer-base { position: absolute; width: 140px; height: 140px; margin: -70px 0 0 -70px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.2); display: none; }
			.steer-knob { position: absolute; top: 50%; left: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgba(255,255,255,0.35); }

			.on-screen-buttons { position: absolute; bottom: 20px; left: 20px; right: 20px; display: flex; justify-content: space-between; pointer-events: none; z-index: 101; }
			.btn-group { display: flex; gap: 12px; pointer-events: auto; }
			.control-btn { width: 64px; height: 64px; border-radius: 50%; background: rgba(255,255,255,0.25); border: 2px solid rgba(255,255,255,0.4); color: white; font-size: 24px; font-weight: bold; display: flex; align-items: center; justify-content: center; user-select: none; -webkit-user-select: none; touch-action: none; backdrop-filter: blur(4px); }
			.control-btn:active { background: rgba(255,255,255,0.5); }
		`;
		document.head.appendChild( css );

		const container = document.createElement( 'div' );
		container.className = 'touch-controls';

		const steerZone = document.createElement( 'div' );
		steerZone.className = 'steer-zone';

		const base = document.createElement( 'div' );
		base.className = 'steer-base';
		const knob = document.createElement( 'div' );
		knob.className = 'steer-knob';
		base.appendChild( knob );
		steerZone.appendChild( base );

		container.appendChild( steerZone );

		// On-screen D-Pad / Buttons UI
		const buttonsOverlay = document.createElement( 'div' );
		buttonsOverlay.className = 'on-screen-buttons';
		if ( ! isTouch ) {

			buttonsOverlay.style.display = 'none';

		}

		buttonsOverlay.innerHTML = `
			<div class="btn-group">
				<div id="btn-left" class="control-btn">◀</div>
				<div id="btn-right" class="control-btn">▶</div>
			</div>
			<div class="btn-group">
				<div id="btn-down" class="control-btn">▼</div>
				<div id="btn-up" class="control-btn">▲</div>
			</div>
		`;
		document.body.appendChild( buttonsOverlay );
		document.body.appendChild( container );

		const setupBtn = ( id, keyName ) => {

			const el = document.getElementById( id );
			if ( ! el ) return;
			const start = ( e ) => {

				e.preventDefault();
				this[ keyName ] = true;

			};
			const end = ( e ) => {

				e.preventDefault();
				this[ keyName ] = false;

			};
			el.addEventListener( 'pointerdown', start );
			el.addEventListener( 'pointerup', end );
			el.addEventListener( 'pointercancel', end );
			el.addEventListener( 'pointerleave', end );

		};

		setupBtn( 'btn-left', 'btnLeft' );
		setupBtn( 'btn-right', 'btnRight' );
		setupBtn( 'btn-up', 'btnUp' );
		setupBtn( 'btn-down', 'btnDown' );

		const steerRange = 40;

		steerZone.addEventListener( 'pointerdown', ( e ) => {

			if ( e.target.classList.contains( 'control-btn' ) ) return;
			if ( this.steerPointerId !== null ) return;
			steerZone.setPointerCapture( e.pointerId );
			this.steerPointerId = e.pointerId;
			this.steerStartX = e.clientX;
			this.steerStartY = e.clientY;
			this.touchActive = true;
			this.touchDirX = 0;
			this.touchDirY = 0;
			base.style.left = `${ e.clientX }px`;
			base.style.top = `${ e.clientY }px`;
			base.style.display = 'block';

		} );

		steerZone.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			let dx = ( e.clientX - this.steerStartX ) / steerRange;
			let dy = ( e.clientY - this.steerStartY ) / steerRange;
			const mag = Math.sqrt( dx * dx + dy * dy );

			if ( mag > 1 ) {

				dx /= mag;
				dy /= mag;

			}

			this.touchDirX = dx;
			this.touchDirY = dy;
			knob.style.transform = `translate(${ this.touchDirX * 60 }px, ${ this.touchDirY * 60 }px)`;

		} );

		const endSteer = ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			this.steerPointerId = null;
			this.touchActive = false;
			this.touchDirX = 0;
			this.touchDirY = 0;
			knob.style.transform = '';
			base.style.display = 'none';

		};

		steerZone.addEventListener( 'pointerup', endSteer );
		steerZone.addEventListener( 'pointercancel', endSteer );

	}

	update() {

		let x = 0, z = 0;

		// Keyboard & On-Screen UI Buttons

		if ( this.keys[ 'KeyA' ] || this.keys[ 'ArrowLeft' ] || this.btnLeft ) x -= 1;
		if ( this.keys[ 'KeyD' ] || this.keys[ 'ArrowRight' ] || this.btnRight ) x += 1;
		if ( this.keys[ 'KeyW' ] || this.keys[ 'ArrowUp' ] || this.btnUp ) z += 1;
		if ( this.keys[ 'KeyS' ] || this.keys[ 'ArrowDown' ] || this.btnDown ) z -= 1;

		// Gamepad & Meta Quest Controllers

		const gamepads = navigator.getGamepads();

		for ( const gp of gamepads ) {

			if ( ! gp ) continue;

			// Check left/right thumbstick X-axis for steering (axes[0] or axes[2])
			const stickX1 = gp.axes[ 0 ] || 0;
			const stickX2 = gp.axes[ 2 ] || 0;
			const stickX = Math.abs( stickX1 ) > Math.abs( stickX2 ) ? stickX1 : stickX2;

			if ( Math.abs( stickX ) > 0.15 ) x = stickX;

			// Check Triggers & Grips (buttons 0, 1, 6, 7) or thumbstick Y-axis for acceleration/reverse
			const triggerR = gp.buttons[ 7 ] ? gp.buttons[ 7 ].value : ( gp.buttons[ 0 ] ? gp.buttons[ 0 ].value : 0 );
			const triggerL = gp.buttons[ 6 ] ? gp.buttons[ 6 ].value : ( gp.buttons[ 1 ] ? gp.buttons[ 1 ].value : 0 );

			if ( triggerR > 0.1 || triggerL > 0.1 ) {

				z = triggerR - triggerL;

			} else {

				// Fallback to Y-axis of thumbstick (axes[1] or axes[3])
				const stickY1 = gp.axes[ 1 ] || 0;
				const stickY2 = gp.axes[ 3 ] || 0;
				const stickY = Math.abs( stickY1 ) > Math.abs( stickY2 ) ? stickY1 : stickY2;

				if ( Math.abs( stickY ) > 0.15 ) {

					z = - stickY;

				}

			}

			if ( Math.abs( x ) > 0.05 || Math.abs( z ) > 0.05 ) break;

		}

		// Touch — joystick mapped to world space (camera is 45° azimuth)

		if ( this.touchActive ) {

			const jx = this.touchDirX;
			const jy = this.touchDirY;
			const mag = Math.sqrt( jx * jx + jy * jy );

			if ( mag > 0.15 ) {

				x = ( jx + jy ) * Math.SQRT1_2 / mag;
				z = ( - jx + jy ) * Math.SQRT1_2 / mag;

			}

		}

		this.x = x;
		this.z = z;

		return { x, z, touchActive: this.touchActive };

	}

}
