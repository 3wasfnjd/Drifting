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

		// Mobile gyro steering
		this.gyroSupported = 'DeviceOrientationEvent' in window;
		this.gyroEnabled = false;
		this.gyroCalibrated = false;
		this.gyroCenter = 0;
		this.gyroAngle = 0;
		this.gyroSteer = 0;
		this.gyroDeadZone = 2.5;
		this.gyroMaxAngle = 28;
		this.gyroSmoothing = 0.18;
		this.gyroButton = null;

		this._onDeviceOrientation = ( e ) => this.handleDeviceOrientation( e );

		window.addEventListener( 'keydown', ( e ) => this.keys[ e.code ] = true );
		window.addEventListener( 'keyup', ( e ) => this.keys[ e.code ] = false );

	}

	getScreenAngle() {

		if ( screen.orientation && Number.isFinite( screen.orientation.angle ) ) return screen.orientation.angle;
		if ( Number.isFinite( window.orientation ) ) return window.orientation;
		return 0;

	}

	getTiltAngle( beta, gamma ) {

		const angle = ( ( this.getScreenAngle() % 360 ) + 360 ) % 360;

		if ( angle === 90 ) return beta;
		if ( angle === 270 ) return - beta;
		if ( angle === 180 ) return - gamma;
		return gamma;

	}

	handleDeviceOrientation( e ) {

		if ( ! this.gyroEnabled ) return;
		if ( ! Number.isFinite( e.beta ) || ! Number.isFinite( e.gamma ) ) return;

		const angle = this.getTiltAngle( e.beta, e.gamma );
		this.gyroAngle = angle;

		if ( ! this.gyroCalibrated ) {

			this.gyroCenter = angle;
			this.gyroCalibrated = true;
			this.gyroSteer = 0;
			return;

		}

		let delta = angle - this.gyroCenter;
		if ( Math.abs( delta ) <= this.gyroDeadZone ) {

			delta = 0;

		} else {

			delta -= Math.sign( delta ) * this.gyroDeadZone;

		}

		const usableRange = Math.max( 1, this.gyroMaxAngle - this.gyroDeadZone );
		const target = Math.max( - 1, Math.min( 1, delta / usableRange ) );
		this.gyroSteer += ( target - this.gyroSteer ) * this.gyroSmoothing;

	}

	calibrateGyro() {

		this.gyroCenter = this.gyroAngle;
		this.gyroCalibrated = true;
		this.gyroSteer = 0;

	}

	async enableGyro() {

		if ( ! this.gyroSupported ) return false;

		try {

			if ( typeof DeviceOrientationEvent.requestPermission === 'function' ) {

				const permission = await DeviceOrientationEvent.requestPermission();
				if ( permission !== 'granted' ) return false;

			}

			if ( ! this.gyroEnabled ) {

				window.addEventListener( 'deviceorientation', this._onDeviceOrientation, true );
				this.gyroEnabled = true;
				this.gyroCalibrated = false;
				this.gyroSteer = 0;

			}

			return true;

		} catch ( error ) {

			console.warn( 'Gyro steering could not be enabled:', error );
			return false;

		}

	}

	setupTouchUI() {

		if ( ! ( 'ontouchstart' in window ) ) return;

		const css = document.createElement( 'style' );
		css.textContent = `
			.touch-controls { position: absolute; inset: 0; pointer-events: none; z-index: 100; }
			.steer-zone { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }
			.steer-base { position: absolute; width: 140px; height: 140px; margin: -70px 0 0 -70px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.2); display: none; }
			.steer-knob { position: absolute; top: 50%; left: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgba(255,255,255,0.35); }
			.drive-buttons { position: absolute; right: 18px; bottom: 18px; display: flex; gap: 12px; align-items: flex-end; pointer-events: auto; z-index: 3; }
			.drive-btn { width: 84px; height: 84px; border: 2px solid rgba(255,255,255,0.35); border-radius: 50%; background: rgba(0,0,0,0.35); color: white; font: 700 14px/1 sans-serif; touch-action: none; -webkit-user-select: none; user-select: none; }
			.drive-btn.active { background: rgba(255,255,255,0.28); transform: scale(0.96); }
			.gyro-controls { position: absolute; left: 14px; top: 14px; display: flex; gap: 8px; pointer-events: auto; z-index: 3; }
			.gyro-btn { min-width: 82px; height: 38px; padding: 0 12px; border: 1px solid rgba(255,255,255,0.35); border-radius: 18px; background: rgba(0,0,0,0.48); color: #fff; font: 700 12px/1 sans-serif; touch-action: manipulation; }
			.gyro-btn.enabled { background: rgba(28,110,54,0.72); }
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

		const driveButtons = document.createElement( 'div' );
		driveButtons.className = 'drive-buttons';

		const brakeBtn = document.createElement( 'button' );
		brakeBtn.className = 'drive-btn';
		brakeBtn.textContent = 'BRAKE';

		const gasBtn = document.createElement( 'button' );
		gasBtn.className = 'drive-btn';
		gasBtn.textContent = 'GAS';

		driveButtons.appendChild( brakeBtn );
		driveButtons.appendChild( gasBtn );

		const gyroControls = document.createElement( 'div' );
		gyroControls.className = 'gyro-controls';

		const gyroBtn = document.createElement( 'button' );
		gyroBtn.className = 'gyro-btn';
		gyroBtn.textContent = this.gyroSupported ? 'GYRO' : 'NO GYRO';
		gyroBtn.disabled = ! this.gyroSupported;
		this.gyroButton = gyroBtn;

		const calibrateBtn = document.createElement( 'button' );
		calibrateBtn.className = 'gyro-btn';
		calibrateBtn.textContent = 'CENTER';
		calibrateBtn.disabled = true;

		gyroControls.appendChild( gyroBtn );
		gyroControls.appendChild( calibrateBtn );

		container.appendChild( steerZone );
		container.appendChild( driveButtons );
		container.appendChild( gyroControls );
		document.body.appendChild( container );

		const bindHoldButton = ( button, property ) => {

			const press = ( e ) => {

				e.preventDefault();
				e.stopPropagation();
				this[ property ] = true;
				button.classList.add( 'active' );
				if ( button.setPointerCapture ) button.setPointerCapture( e.pointerId );

			};

			const release = ( e ) => {

				e.preventDefault();
				e.stopPropagation();
				this[ property ] = false;
				button.classList.remove( 'active' );

			};

			button.addEventListener( 'pointerdown', press );
			button.addEventListener( 'pointerup', release );
			button.addEventListener( 'pointercancel', release );
			button.addEventListener( 'lostpointercapture', () => {

				this[ property ] = false;
				button.classList.remove( 'active' );

			} );

		};

		bindHoldButton( gasBtn, 'btnUp' );
		bindHoldButton( brakeBtn, 'btnDown' );

		gyroBtn.addEventListener( 'click', async ( e ) => {

			e.preventDefault();
			e.stopPropagation();

			if ( this.gyroEnabled ) {

				this.calibrateGyro();
				gyroBtn.textContent = 'GYRO ON';
				return;

			}

			const enabled = await this.enableGyro();
			if ( enabled ) {

				gyroBtn.textContent = 'GYRO ON';
				gyroBtn.classList.add( 'enabled' );
				calibrateBtn.disabled = false;
				base.style.display = 'none';

			} else {

				gyroBtn.textContent = 'GYRO BLOCKED';

			}

		} );

		calibrateBtn.addEventListener( 'click', ( e ) => {

			e.preventDefault();
			e.stopPropagation();
			this.calibrateGyro();

		} );

		const steerRange = 40;

		steerZone.addEventListener( 'pointerdown', ( e ) => {

			if ( this.gyroEnabled ) return;
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

			if ( this.gyroEnabled ) return;
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

		// Keyboard

		if ( this.keys[ 'KeyA' ] || this.keys[ 'ArrowLeft' ] ) x -= 1;
		if ( this.keys[ 'KeyD' ] || this.keys[ 'ArrowRight' ] ) x += 1;
		if ( this.keys[ 'KeyW' ] || this.keys[ 'ArrowUp' ] ) z += 1;
		if ( this.keys[ 'KeyS' ] || this.keys[ 'ArrowDown' ] ) z -= 1;

		// Gamepad & Meta Quest Controllers

		const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];

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

		// Mobile gyro steering. Gas/brake stay on dedicated touch buttons.
		if ( this.gyroEnabled ) {

			x = this.gyroSteer;
			if ( this.btnUp && ! this.btnDown ) z = 1;
			else if ( this.btnDown && ! this.btnUp ) z = - 1;
			else if ( this.btnUp && this.btnDown ) z = 0;

		} else if ( this.touchActive ) {

			// Touch joystick fallback for devices where gyro is unavailable/disabled.
			const jx = this.touchDirX;
			const jy = this.touchDirY;
			const mag = Math.sqrt( jx * jx + jy * jy );

			if ( mag > 0.15 ) {

				x = ( jx + jy ) * Math.SQRT1_2 / mag;
				z = ( - jx + jy ) * Math.SQRT1_2 / mag;

			}

		}

		// Dedicated touch gas/brake also work while gyro is disabled.
		if ( this.btnUp && ! this.btnDown ) z = 1;
		else if ( this.btnDown && ! this.btnUp ) z = - 1;
		else if ( this.btnUp && this.btnDown ) z = 0;

		this.x = x;
		this.z = z;

		const mobileInputActive = this.touchActive || this.btnUp || this.btnDown || ( this.gyroEnabled && Math.abs( this.gyroSteer ) > 0.05 );
		return { x, z, touchActive: mobileInputActive };

	}

}
