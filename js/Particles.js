import * as THREE from 'three';

const DEFAULT_POOL_SIZE = 1280;
const DEFAULT_PARTICLES_PER_EMIT = 3;
const DEFAULT_MAX_LIFE = 2.5;

const _blPos = new THREE.Vector3();
const _brPos = new THREE.Vector3();

export class SmokeTrails {

	constructor( scene, {
		poolSize = DEFAULT_POOL_SIZE,
		particlesPerEmit = DEFAULT_PARTICLES_PER_EMIT,
		scale = 1,
		maxLife = DEFAULT_MAX_LIFE,
		emitInterval = 0,
	} = {} ) {

		this.poolSize = poolSize;
		this.particlesPerEmit = particlesPerEmit;
		this.scale = scale;
		this.maxLife = maxLife;
		this.invMaxLife = 1 / maxLife;
		this.emitInterval = emitInterval;
		this.emitAccumulator = 0;

		const positions = new Float32Array( poolSize * 3 );
		const opacities = new Float32Array( poolSize );
		const sizes = new Float32Array( poolSize );

		const geometry = new THREE.BufferGeometry();

		const posAttr = new THREE.BufferAttribute( positions, 3 );
		posAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'position', posAttr );

		const opacityAttr = new THREE.BufferAttribute( opacities, 1 );
		opacityAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'aOpacity', opacityAttr );

		const sizeAttr = new THREE.BufferAttribute( sizes, 1 );
		sizeAttr.setUsage( THREE.DynamicDrawUsage );
		geometry.setAttribute( 'aSize', sizeAttr );

		const map = new THREE.TextureLoader().load( 'sprites/smoke.png' );

		const material = new THREE.PointsMaterial( {
			map,
			color: 0x5E5F6B,
			size: 1,
			sizeAttenuation: true,
			transparent: true,
			depthWrite: false,
		} );

		// PointsMaterial has no per-vertex size or alpha, so inject attributes
		// and fold them into gl_PointSize and diffuseColor.a.
		material.onBeforeCompile = ( shader ) => {

			shader.vertexShader = 'attribute float aSize;\nattribute float aOpacity;\nvarying float vOpacity;\n' + shader.vertexShader;
			shader.vertexShader = shader.vertexShader.replace(
				'void main() {',
				'void main() {\n\tvOpacity = aOpacity;'
			);
			shader.vertexShader = shader.vertexShader.replace(
				'gl_PointSize = size;',
				'gl_PointSize = size * aSize;'
			);

			shader.fragmentShader = 'varying float vOpacity;\n' + shader.fragmentShader;
			shader.fragmentShader = shader.fragmentShader.replace(
				'vec4 diffuseColor = vec4( diffuse, opacity );',
				'vec4 diffuseColor = vec4( diffuse, opacity * vOpacity );'
			);

		};

		const points = new THREE.Points( geometry, material );
		points.frustumCulled = false;
		scene.add( points );

		this.posAttr = posAttr;
		this.opacityAttr = opacityAttr;
		this.sizeAttr = sizeAttr;
		this.positions = positions;
		this.opacities = opacities;
		this.sizes = sizes;

		this.particles = [];

		for ( let i = 0; i < this.poolSize; i ++ ) {

			this.particles.push( {
				life: 0,
				velocity: new THREE.Vector3(),
				initialSize: 0,
			} );

		}

		this.emitIndex = 0;

	}

	update( dt, vehicle ) {

		const shouldEmit = vehicle.driftIntensity > 0.7;
		let aliveCount = 0;

		if ( shouldEmit ) this.emitAccumulator += dt;
		const emitNow = shouldEmit && ( this.emitInterval === 0 || this.emitAccumulator >= this.emitInterval );

		if ( emitNow ) {

			this.emitAccumulator = 0;
			const roadY = vehicle.container.position.y + 0.05 * this.scale;
			const bl = vehicle.wheelBL ? vehicle.wheelBL.getWorldPosition( _blPos ) : null;
			const br = vehicle.wheelBR ? vehicle.wheelBR.getWorldPosition( _brPos ) : null;

			for ( let i = 0; i < this.particlesPerEmit; i ++ ) {

				if ( bl ) this.emitAt( bl.x, roadY, bl.z );
				if ( br ) this.emitAt( br.x, roadY, br.z );

			}

		}

		const damping = 1 - dt;

		for ( let i = 0; i < this.poolSize; i ++ ) {

			const p = this.particles[ i ];
			if ( p.life <= 0 ) continue;

			p.life -= dt;

			if ( p.life <= 0 ) {

				this.opacities[ i ] = 0;
				aliveCount ++;
				continue;

			}

			const t = 1 - p.life * this.invMaxLife;

			p.velocity.multiplyScalar( damping );

			const posIdx = i * 3;
			this.positions[ posIdx ] += p.velocity.x * dt;
			this.positions[ posIdx + 1 ] += p.velocity.y * dt;
			this.positions[ posIdx + 2 ] += p.velocity.z * dt;

			this.opacities[ i ] = ( 1 - t ) * 0.25;
			this.sizes[ i ] = p.initialSize * ( 0.5 + t * 2.5 );

			aliveCount ++;

		}

		if ( shouldEmit || aliveCount > 0 ) {

			this.posAttr.needsUpdate = true;
			this.opacityAttr.needsUpdate = true;
			this.sizeAttr.needsUpdate = true;

		}

	}

	emitAt( x, y, z ) {

		const i = this.emitIndex;
		this.emitIndex = ( i + 1 ) % this.poolSize;

		const p = this.particles[ i ];

		const posIdx = i * 3;
		const jitter = 0.15 * this.scale;
		this.positions[ posIdx ] = x + ( Math.random() - 0.5 ) * jitter;
		this.positions[ posIdx + 1 ] = y + Math.random() * jitter;
		this.positions[ posIdx + 2 ] = z + ( Math.random() - 0.5 ) * jitter;

		p.initialSize = this.scale * ( 0.5 + Math.random() * 0.5 );

		p.velocity.set(
			( Math.random() - 0.5 ) * 0.2 * this.scale,
			( 0.5 + Math.random() * 0.5 ) * this.scale,
			( Math.random() - 0.5 ) * 0.2 * this.scale
		);

		p.life = this.maxLife;

	}

}
