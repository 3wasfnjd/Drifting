import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { rigidBody, box, MotionType } from 'crashcat';

const DEADZONE = 0.15;
const MOVE_SPEED = 1.5;
const ROTATE_SPEED = 1.2;

export class ARManager {
	constructor( { renderer, scene, buildFreeRoamFloor = true, placementEnabled = true, spawnHeight = 0.5 } ) {
		this.renderer=renderer;this.scene=scene;this.buildFreeRoamFloor=buildFreeRoamFloor;this.placementEnabled=placementEnabled;this.spawnHeight=spawnHeight;this.session=null;this.hitTestSource=null;this.hitTestSourceRequested=false;this.hasHit=false;this.placed=false;this.arPosition=new THREE.Vector3();this.arQuaternion=new THREE.Quaternion();this.previewGroup=this.buildPreviewMesh();this.previewGroup.visible=false;this.scene.add(this.previewGroup);this.world=null;this.gamepads={left:null,right:null};this.controllers={left:null,right:null};this.selectionRaysVisible=false;this._prevTrigger={left:false,right:false};this.placementTriggerArmed=false;this.controllerModelFactory=new XRControllerModelFactory();this._setupControllers();this._savedBackground=null;this._savedFog=null;this.onPlaced=null;this._camForward=new THREE.Vector3();this._camPos=new THREE.Vector3();
	}
	setWorld(world){this.world=world}
	static async isSupported(){if(!navigator.xr)return false;try{return await navigator.xr.isSessionSupported('immersive-ar')}catch(e){return false}}
	async requestSession(pendingSession=null){this.hasHit=false;this.placed=false;this._prevTrigger.left=false;this._prevTrigger.right=false;this.placementTriggerArmed=false;const session=pendingSession?await pendingSession:await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['local-floor','hit-test']});this.renderer.xr.setReferenceSpaceType('local-floor');await this.renderer.xr.setSession(session);this.session=session;session.addEventListener('end',()=>this._onSessionEnd());this._savedBackground=this.scene.background;this._savedFog=this.scene.fog;this.scene.background=null;this.scene.fog=null;this.previewGroup.visible=this.placementEnabled;return session}
	_setupControllers(){for(let i=0;i<2;i++){const controller=this.renderer.xr.getController(i);controller.addEventListener('connected',event=>{const hand=event.data.handedness==='left'?'left':'right';this.gamepads[hand]=event.data.gamepad||null;this.controllers[hand]=controller;if(controller.userData.selectionRay)controller.userData.selectionRay.visible=this.selectionRaysVisible});controller.addEventListener('disconnected',event=>{const hand=event.data.handedness==='left'?'left':'right';this.gamepads[hand]=null});this.scene.add(controller);const ray=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-3)]),new THREE.LineBasicMaterial({color:0x66ddff,transparent:true,opacity:.75}));ray.visible=false;controller.userData.selectionRay=ray;controller.add(ray);const grip=this.renderer.xr.getControllerGrip(i);this.scene.add(grip);try{grip.add(this.controllerModelFactory.createControllerModel(grip))}catch(e){console.warn('Controller model failed to load (non-fatal):',e)}}}
	setSelectionRaysVisible(visible){this.selectionRaysVisible=visible;for(const controller of Object.values(this.controllers))if(controller?.userData.selectionRay)controller.userData.selectionRay.visible=visible}
	buildPreviewMesh(){const group=new THREE.Group();const ring=new THREE.Mesh(new THREE.RingGeometry(.45,.55,32),new THREE.MeshBasicMaterial({color:0x15A249,transparent:true,opacity:.8,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.02;group.add(ring);const fill=new THREE.Mesh(new THREE.CircleGeometry(.45,32),new THREE.MeshBasicMaterial({color:0x15A249,transparent:true,opacity:.25,side:THREE.DoubleSide}));fill.rotation.x=-Math.PI/2;fill.position.y=.015;group.add(fill);const arrow=new THREE.Mesh(new THREE.ConeGeometry(.14,.5,12),new THREE.MeshBasicMaterial({color:0x159897}));arrow.rotation.x=Math.PI/2;arrow.position.set(0,.05,-.55);group.add(arrow);return group}
	update(frame,dt){if(!this.session||!frame)return;if(!this.placementEnabled&&!this.placed)return;try{const refSpace=this.renderer.xr.getReferenceSpace();this._ensureHitTestSource();if(this.placementEnabled&&!this.placed)this._updatePlacement(frame,refSpace,dt)}catch(e){console.error('[ARManager] update() error:',e)}}
	setPlacementEnabled(enabled){this.placementEnabled=enabled;this.placementTriggerArmed=false;this.hasHit=false;this.previewGroup.visible=false}
	_ensureHitTestSource(){if(this.hitTestSourceRequested)return;this.hitTestSourceRequested=true;this.session.requestReferenceSpace('viewer').then(viewerSpace=>{this.session.requestHitTestSource({space:viewerSpace}).then(source=>{this.hitTestSource=source}).catch(e=>console.warn('[ARManager] requestHitTestSource failed:',e))}).catch(e=>console.warn('[ARManager] requestReferenceSpace(viewer) failed:',e))}
	_updatePlacement(frame,refSpace,dt){this._updateHitTestPose(frame,refSpace,dt);this.previewGroup.position.copy(this.arPosition);this.previewGroup.quaternion.copy(this.arQuaternion);this.previewGroup.visible=this.hasHit;if(!this.placementTriggerArmed){const pressed=this._syncTriggerState();if(!pressed)this.placementTriggerArmed=true;return}if(this.hasHit&&this._triggerPressedEdge())this._confirmPlacement()}
	_updateHitTestPose(frame,refSpace,dt){if(this.hitTestSource){const results=frame.getHitTestResults(this.hitTestSource);if(results.length>0){const pose=results[0].getPose(refSpace);if(!this.hasHit){const xrCam=this.renderer.xr.getCamera();this._camPos.setFromMatrixPosition(xrCam.matrixWorld);this._camForward.set(0,0,-1).transformDirection(xrCam.matrixWorld);const yaw=Math.atan2(this._camForward.x,this._camForward.z);this.arQuaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),yaw)}this.arPosition.set(pose.transform.position.x,pose.transform.position.y,pose.transform.position.z);this.hasHit=true}}if(this.hasHit)this._applyThumbstickAdjustment(Math.min(dt,1/30))}
	_applyThumbstickAdjustment(dt){const axesR=this.gamepads.right?this.gamepads.right.axes:[],axesL=this.gamepads.left?this.gamepads.left.axes:[];const moveX=this._axis(axesR,2),moveY=this._axis(axesR,3),rotX=this._axis(axesL,2);if(moveX!==0||moveY!==0){const xrCam=this.renderer.xr.getCamera();const forward=this._camForward.set(0,0,-1).transformDirection(xrCam.matrixWorld);forward.y=0;forward.normalize();const right=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0)).negate();this.arPosition.addScaledVector(right,moveX*MOVE_SPEED*dt).addScaledVector(forward,-moveY*MOVE_SPEED*dt)}if(rotX!==0){const deltaYaw=-rotX*ROTATE_SPEED*dt;this.arQuaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),deltaYaw))}}
	_axis(axes,index){const v=axes&&axes.length>index?axes[index]:0;return Math.abs(v)>DEADZONE?v:0}
	_triggerPressedEdge(){const r=!!this.gamepads.right?.buttons?.[0]?.pressed,l=!!this.gamepads.left?.buttons?.[0]?.pressed;const edge=(r&&!this._prevTrigger.right)||(l&&!this._prevTrigger.left);this._prevTrigger.right=r;this._prevTrigger.left=l;return edge}
	_syncTriggerState(){const r=!!this.gamepads.right?.buttons?.[0]?.pressed,l=!!this.gamepads.left?.buttons?.[0]?.pressed;this._prevTrigger.right=r;this._prevTrigger.left=l;return r||l}
	_confirmPlacement(){this.placed=true;this.previewGroup.visible=false;if(this.world&&this.buildFreeRoamFloor)this._buildFreeRoamFloor();if(this.onPlaced)this.onPlaced(this.getSpawnWorld())}
	_buildFreeRoamFloor(){const halfW=500,halfD=500,floorHalfThickness=Math.min(.01,this.spawnHeight*.25),floorY=this.arPosition.y-floorHalfThickness,cx=this.arPosition.x,cz=this.arPosition.z;rigidBody.create(this.world,{shape:box.create({halfExtents:[halfW,floorHalfThickness,halfD]}),motionType:MotionType.STATIC,objectLayer:this.world._OL_STATIC,position:[cx,floorY,cz],friction:5,restitution:0})}
	isPlaced(){return this.placed}
	getSpawnWorld(){const yaw=new THREE.Euler().setFromQuaternion(this.arQuaternion,'YXZ').y;const position=this.arPosition.clone();position.y+=this.spawnHeight;return{position,angle:yaw}}
	getVehicleScaleInput(){const axesL=this.gamepads.left?this.gamepads.left.axes:[];return-this._axis(axesL,3)}

	// Same driving layout as Hajwala, with trigger calibration so Quest can
	// reliably reach 100% throttle/brake even when the reported analog value
	// tops out slightly below 1.0 on a controller/browser combination.
	getDriveInput(){
		const axesR=this.gamepads.right?this.gamepads.right.axes:[];
		const x=this._axis(axesR,2);
		const rTrig=this.gamepads.right?.buttons?.[0]?.value||0;
		const rGrip=this.gamepads.right?.buttons?.[1]?.value||0;
		const lTrig=this.gamepads.left?.buttons?.[0]?.value||0;
		const leftStickClick=Boolean(this.gamepads.left?.buttons?.[3]?.pressed);
		const normalizePedal=value=>value<.04?0:Math.min(1,value/.82);
		const throttle=normalizePedal(Math.max(rTrig,rGrip));
		const brake=normalizePedal(lTrig);
		const z=THREE.MathUtils.clamp(throttle-brake,-1,1);
		return{x,z,touchActive:false,handbrake:leftStickClick};
	}

	_onSessionEnd(){this.session=null;this.hitTestSource=null;this.hitTestSourceRequested=false;if(this._savedBackground!==null)this.scene.background=this._savedBackground;this.scene.fog=this._savedFog;this.previewGroup.visible=false}
}