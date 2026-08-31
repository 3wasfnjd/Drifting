import * as THREE from 'three';
import { rigidBody } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { createSphereBody } from './Physics.js';

function normalizeAngle(x){return((((x+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2))-Math.PI)}
const _forward=new THREE.Vector3();
function headingY(vehicle){_forward.set(0,0,1).applyQuaternion(vehicle.container.quaternion);return Math.atan2(_forward.x,_forward.z)}

function measureVisualBottomOffset(group){
 group.updateMatrixWorld(true);
 const box=new THREE.Box3().setFromObject(group);
 if(!Number.isFinite(box.min.y))return 0;
 return group.position.y-box.min.y;
}

export function createArenaAI({world,parent,models,center=new THREE.Vector3(),scale=1,count=3}){
 const keys=['vehicle-truck-green','vehicle-truck-purple','vehicle-truck-red'];const drivers=[];const radius=.5*scale;
 for(let i=0;i<count;i++){
  const a=i/count*Math.PI*2,r=10*scale;const pos=[center.x+Math.cos(a)*r,center.y+radius,center.z+Math.sin(a)*r];
  const body=createSphereBody(world,pos,radius),vehicle=new Vehicle();vehicle.rigidBody=body;vehicle.physicsWorld=world;vehicle.visualOffset=radius;vehicle.sphereRadius=radius;vehicle.spawnPos.set(...pos);vehicle.spherePos.set(...pos);vehicle.prevModelPos.set(pos[0],center.y,pos[2]);
  const group=vehicle.init(models[keys[i%keys.length]]);if(scale!==1)group.scale.setScalar(scale);parent.add(group);
  // Measure from the model origin to the lowest visible point once. In AR this
  // avoids mixing world-space Box3 coordinates with the arena's scaled model.
  group.position.set(0,0,0);group.updateMatrixWorld(true);const visualBottomOffset=measureVisualBottomOffset(group);
  drivers.push({vehicle,center:center.clone(),scale,aiState:'CRUISING',stateTimer:1.5+Math.random()*2.5,target:center.clone(),sampleTimer:0,stuckStrikes:0,groundY:center.y,visualBottomOffset});
 }
 return drivers;
}

export function updateArenaAI(drivers,dt,arenaRadius){
 for(const d of drivers){const v=d.vehicle,limit=arenaRadius*d.scale*.90,wander=arenaRadius*d.scale*.72;d.sampleTimer+=dt;
  if(d.sampleTimer>=.5){d.sampleTimer=0;const moved=Math.hypot(v.spherePos.x-(d.sampleX??v.spherePos.x),v.spherePos.z-(d.sampleZ??v.spherePos.z));d.sampleX=v.spherePos.x;d.sampleZ=v.spherePos.z;d.stuckStrikes=moved<.12*d.scale?d.stuckStrikes+1:0}
  if(d.stuckStrikes>=4){const a=Math.random()*Math.PI*2,r=wander*.35,px=d.center.x+Math.cos(a)*r,pz=d.center.z+Math.sin(a)*r,py=d.groundY+v.sphereRadius;rigidBody.setPosition(v.physicsWorld,v.rigidBody,[px,py,pz],false);rigidBody.setLinearVelocity(v.physicsWorld,v.rigidBody,[0,0,0]);rigidBody.setAngularVelocity(v.physicsWorld,v.rigidBody,[0,0,0]);v.spherePos.set(px,py,pz);v.linearSpeed=0;d.stuckStrikes=0;d.aiState='CRUISING';d.stateTimer=2}
  d.stateTimer-=dt;const dx=v.spherePos.x-d.center.x,dz=v.spherePos.z-d.center.z;
  if(Math.hypot(dx,dz)>limit){d.aiState='AVOIDANCE';d.target.set(d.center.x,0,d.center.z)}else if(d.aiState!=='AVOIDANCE'&&d.stateTimer<=0){const roll=Math.random();d.aiState=roll<.45?'DRIFTING':roll<.76?'CRUISING':'DONUT';d.stateTimer=d.aiState==='DONUT'?2.2+Math.random()*2.2:3+Math.random()*4;const a=Math.random()*Math.PI*2,r=wander*Math.sqrt(Math.random());d.target.set(d.center.x+Math.cos(a)*r,0,d.center.z+Math.sin(a)*r)}
  const input={x:0,z:1,touchActive:false,handbrake:false};if(d.aiState==='DONUT'){input.x=1;input.handbrake=Math.sin(performance.now()*.012+drivers.indexOf(d))>.15}else{const tx=d.aiState==='AVOIDANCE'?d.center.x:d.target.x,tz=d.aiState==='AVOIDANCE'?d.center.z:d.target.z,targetAngle=Math.atan2(tx-v.spherePos.x,tz-v.spherePos.z),diff=normalizeAngle(targetAngle-headingY(v)),gain=d.aiState==='DRIFTING'?4:d.aiState==='AVOIDANCE'?3:2;input.x=THREE.MathUtils.clamp(-diff*gain,-1,1);input.z=1;input.handbrake=d.aiState==='DRIFTING'&&Math.abs(diff)>.38;if(d.aiState==='AVOIDANCE'&&Math.hypot(dx,dz)<wander*.7){d.aiState='CRUISING';d.stateTimer=2}}
  v.update(dt,input);
  // Keep the rendered tyres/body bottom exactly on the arena plane. The
  // physics sphere remains at groundY + radius, so driving physics are unchanged.
  v.container.position.y=d.groundY+d.visualBottomOffset;
 }
}
