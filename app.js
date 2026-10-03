import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.181.1/build/three.module.js';
import {OrbitControls} from 'https://cdn.jsdelivr.net/npm/three@0.181.1/examples/jsm/controls/OrbitControls.js';
import {TransformControls} from 'https://cdn.jsdelivr.net/npm/three@0.181.1/examples/jsm/controls/TransformControls.js';
import {GLTFLoader} from 'https://cdn.jsdelivr.net/npm/three@0.181.1/examples/jsm/loaders/GLTFLoader.js';
import {RGBELoader} from 'https://cdn.jsdelivr.net/npm/three@0.181.1/examples/jsm/loaders/RGBELoader.js';

const scene=new THREE.Scene();scene.background=new THREE.Color(0xd9dde2);
const camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.000001,1000000);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance',logarithmicDepthBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;
document.querySelector('#app').append(renderer.domElement);

const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;controls.minDistance=.05;
const transformControls=new TransformControls(camera,renderer.domElement);transformControls.setMode('translate');transformControls.setSize(0.85);transformControls.visible=false;scene.add(transformControls);
transformControls.addEventListener('dragging-changed',e=>{controls.enabled=!e.value&&!walking});
transformControls.addEventListener('change',()=>{if(selected){updateAssetDetails(selected);if(selectionShape)updateShapeOutline(selectionShape);}});
// Neutral exhibition lighting: broad ambient fill + soft directional key.
// Avoid the previous orange point-light hotspot that made the ceiling look much darker than Unity.
const hemi=new THREE.HemisphereLight(0xffffff,0xb8bec6,3.2);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,2.4);sun.position.set(4,10,6);scene.add(sun);
const softFill=new THREE.DirectionalLight(0xffffff,1.1);softFill.position.set(-5,6,-4);scene.add(softFill);
scene.environmentIntensity=1.0;

const ground=new THREE.Mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:0x242a31,roughness:.8}));
ground.rotation.x=-Math.PI/2;ground.visible=false;scene.add(ground);
const grid=new THREE.GridHelper(30,30,0x59636e,0x303740);grid.material.transparent=true;grid.material.opacity=.25;scene.add(grid);

let model=null,selected=null,hovered=null,meshes=[],placeholder=null,selectionBox=null;let selectionShape=null;let previewRenderer=null,previewScene=null,previewCamera=null,previewControls=null;
let walking=false,lookDragging=false,lastX=0,lastY=0,yaw=0,pitch=0,walkSpeed=6,eyeHeight=1.7,walkGroundY=0,walkBounds=null;
let climbing=false,activeLadder=null,climbMinY=0,climbMaxY=0,interactionTarget=null,interactiveDoors=[],openDoorState=new Map();
const keys={};const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
const fileTextureURLs=new Map();
const manager=new THREE.LoadingManager();
manager.setURLModifier(url=>{const clean=url.split('?')[0].split('#')[0];const name=decodeURIComponent(clean.split('/').pop()||'');return fileTextureURLs.get(name)||url});
const loader=new GLTFLoader(manager);const textureLoader=new THREE.TextureLoader();const rgbeLoader=new RGBELoader();
const pmrem=new THREE.PMREMGenerator(renderer);pmrem.compileEquirectangularShader();
const colliders=new Map();let showColliders=false;let hdriTexture=null;let hdriSourceURL=null;
const walkRaycaster=new THREE.Raycaster();

function fitModel(){
 if(!model)return;
 const box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),max=Math.max(size.x,size.y,size.z);
 model.position.x-=center.x;model.position.z-=center.z;model.position.y-=box.min.y;
 const fit=Math.max(max,.1);camera.near=Math.max(fit/1000000,.000001);camera.far=Math.max(fit*10000,10000);camera.updateProjectionMatrix();
 camera.position.set(fit*1.35,fit*.72,fit*1.55);controls.target.set(0,fit*.35,0);controls.maxDistance=Math.max(fit*100,1000);controls.minDistance=Math.max(fit*.00001,.00001);controls.update();
}
function materialsOf(o){return(Array.isArray(o.material)?o.material:[o.material]).filter(Boolean)}
function forEachMaterial(o,fn){materialsOf(o).forEach(fn)}
function applyTextureToSelected(kind,file){
 if(!selected||!file)return;
 const url=URL.createObjectURL(file);
 textureLoader.load(url,tex=>{
   tex.colorSpace=kind==='map'?THREE.SRGBColorSpace:THREE.NoColorSpace;
   tex.wrapS=THREE.RepeatWrapping;tex.wrapT=THREE.RepeatWrapping;
   forEachMaterial(selected,m=>{
     if(!m.userData.textureBackup)m.userData.textureBackup={map:m.map,normalMap:m.normalMap,roughnessMap:m.roughnessMap,metalnessMap:m.metalnessMap,alphaMap:m.alphaMap,transparent:m.transparent,depthWrite:m.depthWrite};
     if(kind==='map')m.map=tex;
     if(kind==='normalMap')m.normalMap=tex;
     if(kind==='roughnessMap')m.roughnessMap=tex;
     if(kind==='metalnessMap')m.metalnessMap=tex;
     if(kind==='alphaMap'){m.alphaMap=tex;m.transparent=true;m.depthWrite=false;m.alphaTest=0.01}
     m.needsUpdate=true;
   });
 });
}
function clearAddedTextures(){
 if(!selected)return;
 forEachMaterial(selected,m=>{
   const b=m.userData.textureBackup;if(!b)return;
   m.map=b.map;m.normalMap=b.normalMap;m.roughnessMap=b.roughnessMap;m.metalnessMap=b.metalnessMap;m.alphaMap=b.alphaMap;m.transparent=b.transparent;m.depthWrite=b.depthWrite;m.needsUpdate=true;
   delete m.userData.textureBackup;
 });
}
function updateCollider(o){
 const c=colliders.get(o);if(!c)return;
 c.box.setFromObject(o);
 if(c.helper)c.helper.box.copy(c.box);
}
function addCollider(o){
 if(!o)return;
 if(!colliders.has(o)){
   const box=new THREE.Box3().setFromObject(o);
   const helper=new THREE.Box3Helper(box,0x35d6ff);
   helper.material.depthTest=false;helper.material.depthWrite=false;helper.renderOrder=998;helper.visible=showColliders;
   scene.add(helper);colliders.set(o,{box,helper});
 }
 updateCollider(o);
}
function removeCollider(o){
 const c=colliders.get(o);if(!c)return;
 scene.remove(c.helper);c.helper.geometry?.dispose();c.helper.material?.dispose();colliders.delete(o);
}
const meshColliders=new Set();const meshColliderHelpers=new Map();
function colliderHitPosition(pos){
 const radius=Math.max(eyeHeight*.18,.14);
 const dx=pos.x-camera.position.x,dz=pos.z-camera.position.z,len=Math.hypot(dx,dz);
 if(len<0.0001)return false;
 const dir=new THREE.Vector3(dx/len,0,dz/len);
 const groundY=getFloorYAt(camera.position.x,camera.position.z,walkGroundY);
 const heights=[.15,eyeHeight*.45,eyeHeight*.9];
 const sideOffsets=[new THREE.Vector3(0,0,0),new THREE.Vector3(-dir.z*radius,0,dir.x*radius),new THREE.Vector3(dir.z*radius,0,-dir.x*radius)];
 for(const o of meshColliders){
   if(!o.visible)continue;
   for(const h of heights)for(const off of sideOffsets){
     const origin=new THREE.Vector3(camera.position.x+off.x,groundY+h,camera.position.z+off.z);
     walkRaycaster.set(origin,dir);
     const hits=walkRaycaster.intersectObject(o,true);
     if(hits.length&&hits[0].distance<=len+radius)return true;
   }
 }
 return false;
}
function addMeshCollider(o){
 if(!o)return;
 meshColliders.add(o);
 if(!meshColliderHelpers.has(o)){
   const helper=new THREE.Group();
   o.traverse(m=>{
     if(!m.isMesh||!m.geometry)return;
     const wire=new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry,25),new THREE.LineBasicMaterial({color:0x35d6ff,transparent:true,opacity:.5,depthTest:false,depthWrite:false}));
     wire.userData.sourceMesh=m;wire.matrixAutoUpdate=false;wire.matrix.copy(m.matrixWorld);wire.renderOrder=997;helper.add(wire);
   });
   helper.visible=showColliders;helper.renderOrder=997;scene.add(helper);meshColliderHelpers.set(o,helper);
 }
}
function removeMeshCollider(o){
 if(!o)return;
 meshColliders.delete(o);
 const helper=meshColliderHelpers.get(o);
 if(helper){scene.remove(helper);helper.traverse(x=>{x.geometry?.dispose();x.material?.dispose()});meshColliderHelpers.delete(o)}
}
function toggleColliders(){
 showColliders=!showColliders;
 colliders.forEach(c=>c.helper.visible=showColliders);
 meshColliderHelpers.forEach(h=>h.visible=showColliders);
 document.querySelector('#showColliders').textContent='Show Mesh Colliders: '+(showColliders?'On':'Off');
}
function clearHighlight(){
 if(selectionBox){scene.remove(selectionBox);selectionBox.geometry?.dispose();selectionBox.material?.dispose();selectionBox=null}
 if(selectionShape){scene.remove(selectionShape);selectionShape.traverse(x=>{x.geometry?.dispose();x.material?.dispose()});selectionShape=null}
 transformControls.detach();transformControls.visible=false;
 selected=null;document.querySelector('#assetControls').style.display='none';document.querySelectorAll('.asset').forEach(b=>b.classList.remove('active'));
}
function createShapeOutline(o,color=0xff8a32,opacity=1){
 const group=new THREE.Group();group.renderOrder=1000;
 o.traverse(m=>{
   if(!m.isMesh||!m.geometry)return;
   const line=new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry,25),new THREE.LineBasicMaterial({color,transparent:opacity<1,opacity,depthTest:false,depthWrite:false}));
   line.userData.sourceMesh=m;line.matrixAutoUpdate=false;line.matrix.copy(m.matrixWorld);line.renderOrder=1000;group.add(line);
 });
 scene.add(group);return group;
}
function updateShapeOutline(group){
 if(!group)return;
 group.children.forEach(line=>{if(line.userData.sourceMesh)line.matrix.copy(line.userData.sourceMesh.matrixWorld)});
}
function setHover(o,e){
 hovered=o||null;
 const info=document.querySelector('#hoverInfo');
 info.style.display='none';
 // Hovering never creates an outline. Highlight is applied only after a click selects the asset.
}
function getMeshStats(o){
 let triangles=0,vertices=0;
 const g=o.geometry;
 if(g){
   const pos=g.attributes?.position;vertices=pos?.count||0;
   triangles=g.index?g.index.count/3:vertices/3;
 }
 return {triangles:Math.round(triangles),vertices};
}
function assetMeta(o,dim){
 const raw=(o.name||'Learning Object').replace(/[_-]+/g,' ').replace(/\\s+/g,' ').trim();
 const lower=raw.toLowerCase();
 let category='LEARNING OBJECT';
 if(/pipe|pvc|valve|connector|elbow|plumb|water/.test(lower))category='PLUMBING';
 else if(/tower|antenna|telecom|cable|server|network|electrical|panel|transformer/.test(lower))category='TELECOM / ELECTRICAL';
 else if(/helmet|glove|ppe|vest|shoe|goggle|safety/.test(lower))category='SAFETY';
 else if(/forklift|crane|machine|motor|pump|generator/.test(lower))category='INDUSTRIAL EQUIPMENT';
 const sku='3D-'+raw.toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,28);
 return {name:raw,category:o.userData?.category||category,price:o.userData?.price||'—',sku:o.userData?.sku||sku,supplier:o.userData?.supplier||'Academy Learning Lab',description:o.userData?.description||'Interactive learning asset. Inspect its form, construction and real-world application in 3D.',dim:[dim.x,dim.y,dim.z].map(v=>v.toFixed(2)).join(' × ')+' m'};
}
function updateAssetDetails(o){
 const s=getMeshStats(o),p=o.position,r=o.scale,bb=new THREE.Box3().setFromObject(o),dim=bb.getSize(new THREE.Vector3()),meta=assetMeta(o,dim);
 document.querySelector('#detailType').textContent=o.isMesh?'Mesh':'Object';
 document.querySelector('#detailTriangles').textContent=s.triangles.toLocaleString();
 document.querySelector('#detailVertices').textContent=s.vertices.toLocaleString();
 document.querySelector('#detailDimensions').textContent=meta.dim;
 document.querySelector('#detailMaterials').textContent=materialsOf(o).length.toString();
 document.querySelector('#selectedCategory').textContent=meta.category;
 document.querySelector('#detailPrice').textContent=meta.price;
 document.querySelector('#selectedName').textContent=meta.name;
 document.querySelector('#detailSku').textContent=meta.sku;
 document.querySelector('#detailSupplier').textContent=meta.supplier;
 document.querySelector('#assetDescription').textContent=meta.description;
 const learning=document.querySelector('#learningFact');
 if(learning)learning.textContent=o.userData?.learning||'Study this object in 3D and compare its form, size and materials with the real-world application.';
}
function initAssetPreview(){
 const host=document.querySelector('#assetPreview');if(!host||previewRenderer)return;
 previewScene=new THREE.Scene();previewScene.background=new THREE.Color(0xf1f3f5);
 previewCamera=new THREE.PerspectiveCamera(35,1,.001,1000);
 previewRenderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
 previewRenderer.setPixelRatio(Math.min(devicePixelRatio,2));previewRenderer.outputColorSpace=THREE.SRGBColorSpace;previewRenderer.toneMapping=THREE.ACESFilmicToneMapping;previewRenderer.toneMappingExposure=1.1;host.append(previewRenderer.domElement);
 previewScene.add(new THREE.HemisphereLight(0xffffff,0x8b929b,2.2));const dl=new THREE.DirectionalLight(0xffffff,2.8);dl.position.set(3,5,4);previewScene.add(dl);
 previewControls=new OrbitControls(previewCamera,previewRenderer.domElement);previewControls.enableDamping=true;previewControls.enablePan=false;previewControls.minDistance=.1;previewControls.maxDistance=100;
 const resize=()=>{const w=host.clientWidth,h=Math.max(host.clientHeight,1);previewCamera.aspect=w/h;previewCamera.updateProjectionMatrix();previewRenderer.setSize(w,h,false)};new ResizeObserver(resize).observe(host);resize();
}
function updateAssetPreview(o){
 initAssetPreview();
 previewScene.children.filter(x=>x.userData?.previewAsset).forEach(x=>previewScene.remove(x));
 const clone=o.clone(true);clone.userData.previewAsset=true;
 clone.traverse(x=>{if(x.isMesh){x.material=Array.isArray(x.material)?x.material.map(m=>m?.clone?.()||m):x.material?.clone?.()||x.material;x.frustumCulled=false}});
 previewScene.add(clone);
 const bb=new THREE.Box3().setFromObject(clone),c=bb.getCenter(new THREE.Vector3()),size=bb.getSize(new THREE.Vector3()),d=Math.max(size.x,size.y,size.z,.01);
 clone.position.sub(c);previewCamera.position.set(d*1.8,d*1.15,d*1.8);previewCamera.near=Math.max(d/1000,.0001);previewCamera.far=Math.max(d*100,100);previewCamera.updateProjectionMatrix();previewControls.target.set(0,0,0);previewControls.update();
}
function selectAsset(o,focus=false){
 if(!o||!o.isMesh)return;
 if(selected===o){document.querySelector('#assetControls').style.display='block';return}
 clearHighlight();selected=o;o.visible=true;
 const b=[...document.querySelectorAll('.asset')].find(x=>x.dataset.meshId===o.uuid);if(b)b.classList.add('active');
 const name=o.name||'Learning Object';document.querySelector('#selectedName').textContent=name;
 updateAssetDetails(o);updateAssetPreview(o);setControlValues();document.querySelector('#assetControls').style.display='block';
 selectionShape=createShapeOutline(o,0xff8a32,1);
 transformControls.detach();transformControls.visible=false;
 if(focus)focusSelectedAsset();
}
function focusSelectedAsset(){
 if(!selected)return;
 const bb=new THREE.Box3().setFromObject(selected),c=bb.getCenter(new THREE.Vector3()),s=bb.getSize(new THREE.Vector3()),d=Math.max(s.x,s.y,s.z,.1);

 // In student walkthrough mode, move the first-person camera close to the
 // exact asset that was clicked and aim directly at it.
 if(walking){
   const current=camera.position.clone();
   const horizontal=new THREE.Vector3(current.x-c.x,0,current.z-c.z);
   if(horizontal.lengthSq()<0.0001)horizontal.set(0,0,1);
   horizontal.normalize();
   const distance=THREE.MathUtils.clamp(d*2.2,1.5,Math.max(d*6,2.5));
   const targetPos=c.clone().addScaledVector(horizontal,distance);
   const floorY=getFloorYAt(targetPos.x,targetPos.z,walkGroundY);
   targetPos.y=floorY+eyeHeight;
   if(walkBounds){
     targetPos.x=THREE.MathUtils.clamp(targetPos.x,walkBounds.minX,walkBounds.maxX);
     targetPos.z=THREE.MathUtils.clamp(targetPos.z,walkBounds.minZ,walkBounds.maxZ);
   }
   camera.position.copy(targetPos);
   const lookTarget=c.clone();
   const lookDir=lookTarget.sub(camera.position).normalize();
   yaw=Math.atan2(-lookDir.x,-lookDir.z);
   pitch=Math.asin(THREE.MathUtils.clamp(lookDir.y,-1,1));
   camera.rotation.order='YXZ';
   camera.rotation.set(pitch,yaw,0);
   return;
 }

 // Standard orbit focus when not walking.
 controls.target.copy(c);
 camera.position.copy(c).add(new THREE.Vector3(d*1.8,d*1.15,d*1.8));
 controls.maxDistance=Math.max(d*100,100);
 controls.update();
}
function showControls(){document.querySelector('#assetControls').style.display='block';setControlValues()}
function setControlValues(){
 if(!selected)return;
 const vals=[selected.rotation.x,selected.rotation.y,selected.rotation.z].map(v=>Math.round(THREE.MathUtils.radToDeg(v)));
 document.querySelector('#selectedCategory').dataset.rotation=vals.join('° / ')+'°';
 transformControls.updateMatrixWorld(true);
}
function setTransformMode(mode){
 transformControls.setMode(mode);
 document.querySelectorAll('#toolMove,#toolMove2').forEach(x=>x?.classList.toggle('toolActive',mode==='translate'));
 document.querySelectorAll('#toolRotate,#toolRotate2').forEach(x=>x?.classList.toggle('toolActive',mode==='rotate'));
 document.querySelectorAll('#toolScale,#toolScale2').forEach(x=>x?.classList.toggle('toolActive',mode==='scale'));
}
// Student mode intentionally exposes inspection only; editing, texture and collider controls are hidden.
document.querySelector('#closeControls').onclick=()=>{document.querySelector('#assetControls').style.display='none'};
document.querySelector('#focusAsset').onclick=()=>{if(selected)focusSelectedAsset()};
document.querySelector('#returnWalk').onclick=()=>{document.querySelector('#assetControls').style.display='none';if(!walking)enterWalk()};

function loadHDRI(file){
 if(!file)return;
 if(hdriSourceURL)URL.revokeObjectURL(hdriSourceURL);
 hdriSourceURL=URL.createObjectURL(file);
 rgbeLoader.load(hdriSourceURL,tex=>{
   if(hdriTexture)hdriTexture.dispose();
   hdriTexture=pmrem.fromEquirectangular(tex).texture;
   scene.environment=hdriTexture;
   scene.environmentIntensity=0.85;
   scene.background=hdriTexture;
   tex.dispose();
 },undefined,err=>{console.error(err);alert('Could not load this HDRI file. Please use a valid .hdr image.')});
}

function populateAssets(){
 const list=document.querySelector('#assetList');meshes=[];
 model?.traverse(o=>{if(o.isMesh){o.userData.originalRotation=o.rotation.clone();meshes.push(o);if(list){const b=document.createElement('button');b.className='asset';b.dataset.meshId=o.uuid;b.textContent=o.name||'Mesh '+meshes.length;b.title=o.name||'';b.onclick=()=>selectAsset(o,true);list.appendChild(b)}}});
 const count=document.querySelector('#assetCount');if(count)count.textContent=meshes.length+' learning objects';
}
// Asset panel is intentionally removed from the main UI; selection is done directly in walkthrough mode.
// Automatically load the Academy GLB from GitHub Pages
const DEFAULT_MODEL_URL =
  'https://github.com/maheshkota1906/3D-WebGL-Academy/raw/refs/heads/main/assets/MyCommunication%20GLB.glb';

function loadDefaultModel(){
  loader.load(DEFAULT_MODEL_URL,g=>{
    if(model)scene.remove(model);

    colliders.forEach(c=>scene.remove(c.helper));
    colliders.clear();

    meshColliders.clear();
    meshColliderHelpers.forEach(h=>{
      scene.remove(h);
      h.traverse(x=>{
        x.geometry?.dispose();
        x.material?.dispose();
      });
    });
    meshColliderHelpers.clear();

    clearHighlight();

    model=g.scene;
    scene.add(model);

    model.traverse(o=>{
      if(o.isMesh){
        o.castShadow=true;
        o.receiveShadow=true;
        o.frustumCulled=false;
        o.userData.originalRotation=o.rotation.clone();

        if(Array.isArray(o.material)){
          o.material=o.material.map(m=>m?.clone?.()||m);
        }else if(o.material?.clone){
          o.material=o.material.clone();
        }

        materialsOf(o).forEach(m=>{
          m.side=THREE.DoubleSide;
          m.depthTest=true;
          m.depthWrite=true;

          if(m.metalnessMap||m.roughnessMap){
            m.metalness=Math.max(m.metalness,0);
            m.roughness=Math.max(m.roughness,.04);
          }

          if(m.normalMap){
            m.normalScale?.set(1,1);
          }

          if(m.alphaMap){
            m.transparent=true;
            m.depthWrite=false;
            m.alphaTest=m.alphaTest||0.01;
          }

          m.needsUpdate=true;
        });
      }
    });

    fitModel();
    populateAssets();
    refreshInteractiveObjects();

    if(placeholder)placeholder.visible=false;

    grid.visible=false;
    ground.visible=false;

    setTimeout(()=>{
      if(model&&!walking)enterWalk();
    },80);

  },undefined,err=>{
    console.error('Default GLB failed to load:',err);
    alert('Could not load the Academy GLB file from GitHub.');
  });
}

document.querySelector('#file').onchange=e=>{
 const files=[...e.target.files];const file=files.find(f=>/\.(glb|gltf)$/i.test(f.name));const hdri=files.find(f=>/\.hdr$/i.test(f.name));if(hdri)loadHDRI(hdri);if(!file)return;
 fileTextureURLs.clear();
 files.forEach(f=>fileTextureURLs.set(f.name,f.type.startsWith('image/')?URL.createObjectURL(f):URL.createObjectURL(f)));
 loader.load(URL.createObjectURL(file),g=>{
   if(model)scene.remove(model);
   colliders.forEach(c=>scene.remove(c.helper));colliders.clear();meshColliders.clear();meshColliderHelpers.forEach(h=>{scene.remove(h);h.traverse(x=>{x.geometry?.dispose();x.material?.dispose()})});meshColliderHelpers.clear();
   clearHighlight();model=g.scene;scene.add(model);
   model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;o.frustumCulled=false;o.userData.originalRotation=o.rotation.clone();if(Array.isArray(o.material))o.material=o.material.map(m=>m?.clone?.()||m);else if(o.material?.clone)o.material=o.material.clone();materialsOf(o).forEach(m=>{m.side=THREE.DoubleSide;m.depthTest=true;m.depthWrite=true;
   // Preserve the full glTF PBR material instead of reducing it to base color.
   // glTF stores metallic + roughness in the standard metallicRoughness texture.
   if(m.metalnessMap||m.roughnessMap){m.metalness=Math.max(m.metalness,0);m.roughness=Math.max(m.roughness,.04)}
   if(m.normalMap){m.normalScale?.set(1,1)}
   // glTF opacity is represented by alpha mode/alpha channel, not a separate opacity slot.
   if(m.alphaMap){m.transparent=true;m.depthWrite=false;m.alphaTest=m.alphaTest||0.01}
   m.needsUpdate=true})}});
   fitModel();populateAssets();refreshInteractiveObjects();if(placeholder)placeholder.visible=false;grid.visible=false;ground.visible=false;setTimeout(()=>{if(model&&!walking)enterWalk()},80);
 },undefined,err=>{console.error(err);alert('Could not load this GLB/GLTF file.')});
};

function updatePointer(e){const r=renderer.domElement.getBoundingClientRect();pointer.x=((e.clientX-r.left)/r.width)*2-1;pointer.y=-((e.clientY-r.top)/r.height)*2+1}
renderer.domElement.addEventListener('pointerdown',e=>{
 if(e.button===2){if(walking){lookDragging=true;lastX=e.clientX;lastY=e.clientY;renderer.domElement.style.cursor='grabbing'}return}
 if(e.button!==0||!model)return;
 // Reliable editor selection: raycast every descendant mesh from the actual renderer canvas.
 // Do not toggle selection off when the selected mesh is clicked again.
 const rect=renderer.domElement.getBoundingClientRect();
 pointer.x=((e.clientX-rect.left)/rect.width)*2-1;
 pointer.y=-((e.clientY-rect.top)/rect.height)*2+1;
 raycaster.setFromCamera(pointer,camera);
 const hits=raycaster.intersectObject(model,true);
 const hit=hits.find(h=>h.object?.isMesh);
 if(hit){
   selectAsset(hit.object,false);
   e.stopPropagation();
   return;
 }
 if(!transformControls.dragging)clearHighlight();
},true);
loadDefaultModel();
document.addEventListener('pointerdown',e=>{
 if(e.button!==0||!model)return;
 if(e.target!==renderer.domElement)return;
 const rect=renderer.domElement.getBoundingClientRect();
 pointer.x=((e.clientX-rect.left)/rect.width)*2-1;
 pointer.y=-((e.clientY-rect.top)/rect.height)*2+1;
 raycaster.setFromCamera(pointer,camera);
 const hit=raycaster.intersectObject(model,true).find(h=>h.object?.isMesh);
 if(hit&&selected!==hit.object)selectAsset(hit.object,false);
},true);
renderer.domElement.addEventListener('pointermove',e=>{
 if(walking&&lookDragging){const dx=e.clientX-lastX,dy=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;yaw-=dx*.003;pitch-=dy*.003;pitch=THREE.MathUtils.clamp(pitch,-1.35,1.35);camera.rotation.order='YXZ';camera.rotation.set(pitch,yaw,0);return}
 if(!lookDragging){updatePointer(e);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObject(model||scene,true).find(h=>h.object?.isMesh);if(hit&&hit.object.isMesh){setHover(hit.object,e);renderer.domElement.style.cursor='default'}else{setHover(null,e);renderer.domElement.style.cursor='default'}}
});
renderer.domElement.addEventListener('pointerup',e=>{if(e.button===2){lookDragging=false;renderer.domElement.style.cursor='default'}});
renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());

function detectWalkGround(){
 if(!model)return {y:0,box:null,mesh:null};
 const modelBox=new THREE.Box3().setFromObject(model);
 const modelSize=modelBox.getSize(new THREE.Vector3());
 const horizontalMax=Math.max(modelSize.x,modelSize.z,.001);
 const verticalMax=Math.max(modelSize.y,.001);
 const candidates=[];
 model.traverse(o=>{
   if(!o.isMesh||!o.geometry||o.userData.isWalkCollider)return;
   const b=new THREE.Box3().setFromObject(o),s=b.getSize(new THREE.Vector3());
   const area=s.x*s.z;
   const thin=s.y/Math.max(Math.min(s.x,s.z),.001);
   const nearBottom=b.min.y<=modelBox.min.y+verticalMax*.18;
   const broad=area>=horizontalMax*horizontalMax*.002;
   if(nearBottom&&broad&&thin<=.25)candidates.push({box:b,area,mesh:o});
 });
 candidates.sort((a,b)=>b.area-a.area);
 const floor=candidates[0];
 return floor?{y:floor.box.max.y,box:floor.box,mesh:floor.mesh}:{y:modelBox.min.y,box:modelBox,mesh:null};
}
function refreshInteractiveObjects(){
 interactiveDoors=[];activeLadder=null;
 if(!model)return;
 model.traverse(o=>{
   if(!o.isMesh)return;
   const n=(o.name||'').toLowerCase().replace(/[ _-]/g,'');
   if(/ladder|towerladder|climb/.test(n))o.userData.interactiveType='ladder';
   if(/server.*door|serverroom.*door|door/.test(n))o.userData.interactiveType='door';
   if(o.userData.interactiveType==='door'&&!interactiveDoors.includes(o))interactiveDoors.push(o);
 });
}
function objectDistance(o,pos){
 const b=new THREE.Box3().setFromObject(o),c=b.getCenter(new THREE.Vector3());
 return Math.hypot(pos.x-c.x,pos.z-c.z);
}
function nearestInteractive(){
 if(!walking||!model)return null;
 const p=camera.position;let best=null,bestD=Infinity;
 model.traverse(o=>{
   if(!o.isMesh||!o.userData.interactiveType)return;
   const d=objectDistance(o,p);if(d<bestD){best=o;bestD=d}
 });
 return best&&bestD<3?{object:best,distance:bestD,type:best.userData.interactiveType}:null;
}
function setInteractionPrompt(html){
 const el=document.querySelector('#interactionPrompt');el.innerHTML=html||'';el.style.display=html?'block':'none';
}
function startClimb(ladder){
 const b=new THREE.Box3().setFromObject(ladder),size=b.getSize(new THREE.Vector3()),center=b.getCenter(new THREE.Vector3());
 climbing=true;activeLadder=ladder;climbMinY=b.min.y+eyeHeight*.55;climbMaxY=b.max.y-eyeHeight*.4;
 camera.position.x=center.x;camera.position.z=center.z+Math.min(Math.max(size.z*.8,.35),1.2);camera.position.y=THREE.MathUtils.clamp(camera.position.y,climbMinY,climbMaxY);
 setInteractionPrompt('<b>CLIMBING</b> W / S = Up / Down &nbsp; • &nbsp; E = Leave Ladder');
}
function stopClimb(){climbing=false;activeLadder=null;setInteractionPrompt('')}
function updateClimb(dt){
 if(!climbing||!activeLadder)return;
 const b=new THREE.Box3().setFromObject(activeLadder),size=b.getSize(new THREE.Vector3()),center=b.getCenter(new THREE.Vector3());
 camera.position.x=center.x;camera.position.z=center.z+Math.min(Math.max(size.z*.8,.35),1.2);
 const v=(keys.KeyW||keys.ArrowUp?1:0)-(keys.KeyS||keys.ArrowDown?1:0);
 camera.position.y=THREE.MathUtils.clamp(camera.position.y+v*walkSpeed*.75*dt,climbMinY,climbMaxY);
}
function openDoor(door){
 let state=openDoorState.get(door);
 if(!state){
   const b=new THREE.Box3().setFromObject(door),size=b.getSize(new THREE.Vector3()),pivot=new THREE.Group(),center=b.getCenter(new THREE.Vector3()),p=center.clone();
   if(size.x>=size.z)p.x=b.min.x;else p.z=b.min.z;
   pivot.position.copy(p);scene.add(pivot);pivot.attach(door);state={pivot,open:false};openDoorState.set(door,state);
 }
 state.open=!state.open;state.pivot.rotation.y=state.open?-Math.PI*.95:0;
}
function interact(){
 const hit=nearestInteractive();if(!hit)return;
 if(hit.type==='ladder')startClimb(hit.object);else if(hit.type==='door')openDoor(hit.object);
}
function updateInteractive(){
 if(!walking||climbing){if(!climbing)setInteractionPrompt('');return}
 const hit=nearestInteractive();interactionTarget=hit?.object||null;
 if(hit?.type==='ladder')setInteractionPrompt('<b>E</b> Climb Tower Ladder');
 else if(hit?.type==='door')setInteractionPrompt('<b>E</b> Open Server Room Door');
 else setInteractionPrompt('');
}
function getFloorYAt(x,z,fallback){
 if(!model)return fallback;
 const top=new THREE.Box3().setFromObject(model).max.y+1;
 walkRaycaster.set(new THREE.Vector3(x,top,z),new THREE.Vector3(0,-1,0));
 const hits=walkRaycaster.intersectObject(model,true);
 let floorY=null;
 for(const hit of hits){
   const o=hit.object;
   if(!o.isMesh||o.userData.isWalkCollider)continue;
   const y=hit.point.y;
   if(y<=top&&y>=fallback-eyeHeight*3)floorY=floorY===null?y:Math.min(floorY,y);
 }
 return floorY===null?fallback:floorY;
}
function academySpawn(){
 if(!model)return false;
 let target=null;
 model.traverse(o=>{if(!target){const n=(o.name||'').toLowerCase();if(n.includes('product_fence')&&n.includes('gate'))target=o;}});
 if(!target)return false;
 const box=new THREE.Box3().setFromObject(target),c=box.getCenter(new THREE.Vector3()),s=box.getSize(new THREE.Vector3());
 const q=new THREE.Quaternion();target.getWorldQuaternion(q);
 const front=new THREE.Vector3(0,0,1).applyQuaternion(q).normalize();
 const d=Math.max(Math.max(s.x,s.z)*0.18,2.2);
 camera.position.copy(c).addScaledVector(front,d);camera.position.y=walkGroundY+eyeHeight;
 const look=c.clone();look.y=walkGroundY+eyeHeight;
 const dir=look.sub(camera.position).normalize();yaw=Math.atan2(-dir.x,-dir.z)+Math.PI;pitch=Math.asin(THREE.MathUtils.clamp(dir.y,-1,1));camera.rotation.order='YXZ';camera.rotation.set(pitch,yaw,0);
 return true;
}
function enterWalk(){
 walking=true;transformControls.visible=false;controls.enabled=false;document.querySelector('aside').style.display='none';document.querySelector('#assetControls').style.display='none';document.querySelector('#walk').classList.add('walking');document.querySelector('#walk').textContent='Exit Walkthrough';document.querySelector('#walkHelp').classList.add('show');
 if(model){
   const b=new THREE.Box3().setFromObject(model),size=b.getSize(new THREE.Vector3());
   const groundInfo=detectWalkGround();
   walkGroundY=groundInfo.y;
   // Use a human-scale eye height: about 1.7 m for a typical adult, scaled only when the model is clearly not meter-sized.
   const floorSpan=Math.max(groundInfo.box?.getSize(new THREE.Vector3()).x||size.x,groundInfo.box?.getSize(new THREE.Vector3()).z||size.z,.001);
   const modelHeight=Math.max(size.y,.001);
   const humanEye=1.7;
   const inferredEye=Math.max(0.35,Math.min(3.0,modelHeight*.34));
   eyeHeight=humanEye;
   if(modelHeight<4)eyeHeight=Math.max(.8,Math.min(1.9,inferredEye));
   const floorBox=groundInfo.box||b;
   const margin=Math.max(Math.min(floorSpan*.015,.75),.25);
   walkBounds={minX:floorBox.min.x+margin,maxX:floorBox.max.x-margin,minZ:floorBox.min.z+margin,maxZ:floorBox.max.z-margin,maxY:b.max.y-.25};
   camera.position.x=THREE.MathUtils.clamp(camera.position.x,walkBounds.minX,walkBounds.maxX);
   camera.position.z=THREE.MathUtils.clamp(camera.position.z,walkBounds.minZ,walkBounds.maxZ);
 }
 const didSpawn=academySpawn();
 if(!didSpawn){const dir=new THREE.Vector3();camera.getWorldDirection(dir);yaw=Math.atan2(-dir.x,-dir.z);pitch=Math.asin(THREE.MathUtils.clamp(dir.y,-1,1));camera.rotation.order='YXZ';camera.rotation.set(pitch,yaw,0);camera.position.y=walkGroundY+eyeHeight;}
}
function exitWalk(){walking=false;lookDragging=false;controls.enabled=true;transformControls.visible=!!selected;document.querySelector('aside').style.display='block';if(selected)document.querySelector('#assetControls').style.display='block';document.querySelector('#walk').classList.remove('walking');document.querySelector('#walk').textContent='Walkthrough';document.querySelector('#walkHelp').classList.remove('show');renderer.domElement.style.cursor='default'}
document.querySelector('#walk').onclick=()=>walking?exitWalk():enterWalk();

addEventListener('keydown',e=>{
 keys[e.code]=true;
 const tag=document.activeElement?.tagName?.toLowerCase();
 if(!walking&&selected&&tag!=='input'&&tag!=='button'&&tag!=='textarea'&&tag!=='select'){
   if(e.code==='KeyW'){e.preventDefault();setTransformMode('translate')}
   if(e.code==='KeyE'){e.preventDefault();setTransformMode('rotate')}
   if(e.code==='KeyR'){e.preventDefault();setTransformMode('scale')}
   if(e.code==='KeyQ'){e.preventDefault();transformControls.detach();transformControls.visible=false;document.querySelector('#toolSelect').classList.add('active')}
 }
 if(e.code==='KeyF'&&selected&&!walking){
   const tag=document.activeElement?.tagName?.toLowerCase();
   if(tag!=='input'&&tag!=='button'&&tag!=='textarea'&&tag!=='select'){e.preventDefault();focusSelectedAsset()}
 }
 if(walking&&['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
 if(e.code==='KeyE'&&walking){e.preventDefault();if(climbing)stopClimb();else interact()}
 if(e.code==='Escape'&&walking){if(climbing)stopClimb();else exitWalk()}
});
addEventListener('keyup',e=>keys[e.code]=false);
function updateWalk(dt){
 if(!walking)return;
 if(climbing){updateClimb(dt);return}
 let f=(keys.KeyW||keys.ArrowUp?1:0)-(keys.KeyS||keys.ArrowDown?1:0),s=(keys.KeyD||keys.ArrowRight?1:0)-(keys.KeyA||keys.ArrowLeft?1:0),len=Math.hypot(f,s);
 if(len){
   f/=len;s/=len;const v=new THREE.Vector3(-Math.sin(yaw)*f+Math.cos(yaw)*s,0,-Math.cos(yaw)*f-Math.sin(yaw)*s);
   const old=camera.position.clone();
   const tryX=camera.position.clone();tryX.x+=v.x*walkSpeed*dt;
   if(!colliderHitPosition(tryX))camera.position.x=tryX.x;
   const tryZ=camera.position.clone();tryZ.z+=v.z*walkSpeed*dt;
   if(!colliderHitPosition(tryZ))camera.position.z=tryZ.z;
 }
 const floorY=getFloorYAt(camera.position.x,camera.position.z,walkGroundY);
 camera.position.y=floorY+eyeHeight;
 if(walkBounds){camera.position.x=THREE.MathUtils.clamp(camera.position.x,walkBounds.minX,walkBounds.maxX);camera.position.z=THREE.MathUtils.clamp(camera.position.z,walkBounds.minZ,walkBounds.maxZ)}
}
document.querySelector('#reset').onclick=()=>{if(walking)exitWalk();fitModel()};
document.querySelector('#full').onclick=()=>document.documentElement.requestFullscreen?.();

function makePlaceholder(){
 const p=new THREE.Group();p.name='Placeholder';placeholder=p;scene.add(p);const mat=c=>new THREE.MeshStandardMaterial({color:c,roughness:.35});
 const box=(x,y,z,w,h,d,c)=>{const q=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(c));q.position.set(x,y,z);p.add(q)};
 box(0,2.5,-3,8,5,.25,0x202832);box(-3.9,2.5,0,.25,5,6,0x202832);box(3.9,2.5,0,.25,5,6,0x202832);box(0,.12,0,7.7,.24,5.8,0x22282e);box(0,2,-2.82,6.8,3.4,.12,0x11161c);box(-2.5,1.2,-2.7,1.8,.12,.5,0xff8a32);box(2.5,1.2,-2.7,1.8,.12,.5,0xff8a32);
}
makePlaceholder();camera.position.set(7,5,9);controls.target.set(0,1.5,0);
document.querySelector('#loading').remove();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
let last=performance.now();renderer.setAnimationLoop(()=>{const now=performance.now(),dt=Math.min((now-last)/1000,.05);last=now;if(walking){updateWalk(dt);updateInteractive()}else controls.update();if(previewControls)previewControls.update();colliders.forEach((_,o)=>updateCollider(o));if(selectionShape&&selected)updateShapeOutline(selectionShape);meshColliderHelpers.forEach(h=>h.children.forEach(line=>{if(line.userData.sourceMesh)line.matrix.copy(line.userData.sourceMesh.matrixWorld)}));renderer.render(scene,camera);if(previewRenderer&&previewScene)previewRenderer.render(previewScene,previewCamera)});
