
(() => {
  const $ = id => document.getElementById(id);

  let scene, camera, renderer, model, raycaster, mouse, clock;
  let selected = null;
  let previewScene, previewCamera, previewRenderer;
  let dragging = false, lastX = 0, lastY = 0;
  let yaw = 0, pitch = 0;
  let keys = {};

  // ATS cabinet doors: animated in code, without changing the GLB asset.
  let atsDoors = [];
  let atsDoorsOpen = false;
  const ATS_DOOR_OPEN_ANGLE = Math.PI / 2;
  const ATS_DOOR_ANIMATION_SPEED = 2.4;

  const MODEL_URL = 'assets/MyCommunicationSite_optimized.glb';

  const state = {
    eye: 1.7,
    speed: 3.2,
    spawn: new THREE.Vector3(0, 1.7, 5)
  };

  function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141b);

    camera = new THREE.PerspectiveCamera(
      70, innerWidth / innerHeight, 0.05, 5000
    );
    camera.position.copy(state.spawn);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;

    $('canvas').appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    clock = new THREE.Clock();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x303845, 2));

    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(8, 15, 6);
    sun.castShadow = true;
    scene.add(sun);

    const grid = new THREE.GridHelper(
      100, 100, 0x39414e, 0x242b35
    );
    grid.position.y = 0;
    scene.add(grid);

    bind();
    animate();
  }

  function bind() {
    // Automatically load the hosted GLB when entering the showroom.
    $('startBtn').onclick = () => {
      hideStart();
      load(MODEL_URL);
    };

    // Hide manual file-loading controls.
    if ($('loadBtn')) $('loadBtn').style.display = 'none';
    if ($('file')) $('file').style.display = 'none';
    if ($('startFile')) $('startFile').style.display = 'none';

    // Keep file-input handlers available if needed internally.
    if ($('file')) {
      $('file').onchange = e => {
        if (e.target.files[0]) load(e.target.files[0]);
      };
    }

    if ($('startFile')) {
      $('startFile').onchange = e => {
        if (e.target.files[0]) load(e.target.files[0]);
      };
    }

    $('help').onclick = () => {
      $('helpPanel').classList.remove('hidden');
    };

    $('closeHelp').onclick = () => {
      $('helpPanel').classList.add('hidden');
    };

    $('closePopup').onclick = clearSelection;
    $('reset').onclick = resetView;
    $('focus').onclick = focusSelected;
    $('resetAsset').onclick = clearSelection;

    addEventListener('resize', resize);

    addEventListener('keydown', e => {
      keys[e.key.toLowerCase()] = true;

      if (e.key.toLowerCase() === 'f') focusSelected();

      if (e.key === 'Escape') {
        clearSelection();
        $('helpPanel').classList.add('hidden');
      }
    });

    addEventListener('keyup', e => {
      keys[e.key.toLowerCase()] = false;
    });

    renderer.domElement.addEventListener('pointerdown', e => {
      dragging = false;
      lastX = e.clientX;
      lastY = e.clientY;
    });

    renderer.domElement.addEventListener('pointermove', e => {
      if (e.buttons === 0) return;

      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragging = true;

      if (dragging) {
        yaw -= dx * 0.003;
        pitch = Math.max(
          -1.35,
          Math.min(1.35, pitch - dy * 0.003)
        );
      }

      lastX = e.clientX;
      lastY = e.clientY;
    });

    addEventListener('pointerup', () => {
      setTimeout(() => { dragging = false; }, 0);
    });

    renderer.domElement.addEventListener('click', pick);

    document.querySelectorAll('#mobile button').forEach(b => {
      b.onpointerdown = () => keys[b.dataset.k] = true;
      b.onpointerup = b.onpointercancel = () => {
        keys[b.dataset.k] = false;
      };
    });
  }

  function hideStart() {
    $('start').style.display = 'none';
    $('reticle').style.display = 'block';
  }

  // Accepts either a hosted URL or a locally selected File.
  function load(source) {
    if (!source) return;

    hideStart();

    const isUrl = typeof source === 'string';
    const url = isUrl ? source : URL.createObjectURL(source);
    const fileName = isUrl
      ? 'MyCommunicationSite_optimized.glb'
      : source.name;

    const loader = new THREE.GLTFLoader();
    const draco = new THREE.DRACOLoader();

    draco.setDecoderPath(
      'https://www.gstatic.com/draco/v1/decoders/'
    );
    loader.setDRACOLoader(draco);

    toast('Loading telecom scene…');

    loader.load(
      url,

      gltf => {
        if (model) scene.remove(model);

        model = gltf.scene;
        model.position.set(0, 0, 0);

        model.traverse(o => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;

            o.userData.originalMaterial = o.material;
            o.userData.originalTransform = {
              p: o.position.clone(),
              q: o.quaternion.clone(),
              s: o.scale.clone()
            };
          }
        });

        scene.add(model);
        setupAtsDoors(model);
        frameModel(model);

        $('modelName').textContent = fileName;
        toast('GLB loaded — click an object to inspect');

        if (!isUrl) URL.revokeObjectURL(url);
      },

      xhr => {
        if (xhr.total) {
          const percent = Math.round(xhr.loaded / xhr.total * 100);
          $('toast').textContent = `Loading telecom scene… ${percent}%`;
          $('toast').style.display = 'block';
        }
      },

      error => {
        console.error('GLB loading failed:', error);

        toast(
          'Could not load GLB. Check the asset URL and try again.'
        );

        if (!isUrl) URL.revokeObjectURL(url);
      }
    );
  }

  function frameModel(m) {
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const max = Math.max(size.x, size.y, size.z);

    state.spawn.set(
      center.x,
      Math.max(box.min.y + state.eye, box.min.y + 0.5),
      center.z + Math.max(max * 1.2, 4)
    );

    camera.position.copy(state.spawn);
    yaw = Math.PI;
    pitch = 0;
  }

  function pick(e) {
    if (!model || dragging) return;

    const r = renderer.domElement.getBoundingClientRect();

    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const hits = raycaster.intersectObject(model, true);
    if (!hits.length) return;

    let o = hits[0].object;

    while (o.parent && o.parent !== model && !o.isMesh) {
      o = o.parent;
    }

    const ats = findAncestorNamed(o, 'ATS');
    if (ats && atsDoors.length) {
      toggleAtsDoors();
    }

    select(o);
  }

  function findAncestorNamed(object, targetName) {
    const target = targetName.toLowerCase();
    let current = object;

    while (current) {
      if ((current.name || '').trim().toLowerCase() === target) return current;
      current = current.parent;
    }
    return null;
  }

  function setupAtsDoors(root) {
    atsDoors = [];
    atsDoorsOpen = false;

    const ats = findAncestorNamedFromRoot(root, 'ATS');
    if (!ats) {
      console.warn('ATS door animation: ATS parent was not found in the GLB.');
      return;
    }

    const doorNames = ['SM_Door_01', 'SM_Door_02'];
    const atsBounds = new THREE.Box3().setFromObject(ats);
    const atsCenter = atsBounds.getCenter(new THREE.Vector3());

    doorNames.forEach((doorName, index) => {
      let door = null;
      ats.traverse(node => {
        if (!door && (node.name || '').trim().toLowerCase() === doorName.toLowerCase()) door = node;
      });

      if (!door) {
        console.warn('ATS door animation: mesh not found:', doorName);
        return;
      }

      door.updateWorldMatrix(true, false);
      const bounds = new THREE.Box3().setFromObject(door);
      const doorCenter = bounds.getCenter(new THREE.Vector3());

      // Hinge at the outer vertical edge of each door (cabinet spans X axis).
      const hingeWorld = new THREE.Vector3(
        index === 0 ? bounds.min.x : bounds.max.x,
        bounds.min.y,
        doorCenter.z
      );

      const parent = door.parent;
      if (!parent) return;

      parent.updateWorldMatrix(true, false);
      const hingeLocal = parent.worldToLocal(hingeWorld.clone());

      const pivot = new THREE.Object3D();
      pivot.name = doorName + '_CodeHinge';
      parent.add(pivot);
      pivot.position.copy(hingeLocal);

      // Reparent while preserving the original world transform.
      pivot.attach(door);

      atsDoors.push({
        name: doorName,
        pivot,
        targetAngle: 0,
        direction: index === 0 ? -1 : 1
      });
    });

    if (atsDoors.length) console.info('ATS door animation ready:', atsDoors.map(d => d.name));
  }

  function findAncestorNamedFromRoot(root, targetName) {
    let found = null;
    const target = targetName.toLowerCase();
    root.traverse(node => {
      if (!found && (node.name || '').trim().toLowerCase() === target) found = node;
    });
    return found;
  }

  function toggleAtsDoors() {
    atsDoorsOpen = !atsDoorsOpen;
    atsDoors.forEach(door => {
      door.targetAngle = atsDoorsOpen ? door.direction * ATS_DOOR_OPEN_ANGLE : 0;
    });
  }

  function updateAtsDoors(dt) {
    atsDoors.forEach(door => {
      const current = door.pivot.rotation.y;
      const difference = door.targetAngle - current;
      const step = ATS_DOOR_ANIMATION_SPEED * dt;
      if (Math.abs(difference) <= step) door.pivot.rotation.y = door.targetAngle;
      else door.pivot.rotation.y += Math.sign(difference) * step;
    });
  }

  function select(o) {
    clearHighlight();

    selected = o;
    o.userData.originalMaterial =
      o.userData.originalMaterial || o.material;

    const base = o.material.clone();
    base.emissive = new THREE.Color(0x38bdf8);
    base.emissiveIntensity = 0.8;

    o.material = base;
    o.userData.highlightMaterial = base;

    $('assetName').textContent = o.name || 'GLB Asset';

    $('assetInfo').textContent =
      (o.geometry?.attributes?.position?.count || 0).toLocaleString()
      + ' vertices • '
      + (o.material?.name || 'PBR material');

    $('popup').classList.remove('hidden');
    makePreview(o);
  }

  function clearHighlight() {
    if (selected && selected.userData.originalMaterial) {
      selected.material = selected.userData.originalMaterial;
    }

    selected = null;
  }

  function clearSelection() {
    clearHighlight();
    $('popup').classList.add('hidden');
  }

  function makePreview(o) {
    const p = $('preview');
    p.innerHTML = '';

    previewScene = new THREE.Scene();
    previewScene.background = new THREE.Color(0x151a23);

    previewCamera = new THREE.PerspectiveCamera(
      45, p.clientWidth / 180, 0.01, 100
    );
    previewCamera.position.set(1.5, 0.9, 2);

    previewRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false
    });

    previewRenderer.setSize(p.clientWidth, 180);
    previewRenderer.outputEncoding = THREE.sRGBEncoding;
    p.appendChild(previewRenderer.domElement);

    previewScene.add(
      new THREE.HemisphereLight(0xffffff, 0x334455, 2)
    );

    const l = new THREE.DirectionalLight(0xffffff, 2);
    l.position.set(2, 3, 2);
    previewScene.add(l);

    const clone = o.clone(true);

    const box = new THREE.Box3().setFromObject(clone);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const m = Math.max(s.x, s.y, s.z) || 1;

    clone.position.sub(c);
    clone.scale.setScalar(1.7 / m);

    previewScene.add(clone);
    previewAnimate();
  }

  function previewAnimate() {
    if (!previewRenderer) return;

    previewRenderer.render(previewScene, previewCamera);
    requestAnimationFrame(previewAnimate);
  }

  function focusSelected() {
    if (!selected) return;

    const b = new THREE.Box3().setFromObject(selected);
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y, s.z) * 2.5;

    camera.position.set(
      c.x,
      c.y + Math.max(s.y * 0.5, 0.4),
      c.z + d
    );

    state.spawn.copy(camera.position);

    yaw = Math.atan2(
      c.x - camera.position.x,
      c.z - camera.position.z
    );

    pitch = 0;
  }

  function resetView() {
    camera.position.copy(state.spawn);
    yaw = 0;
    pitch = 0;
  }

  function update(dt) {
    if (!model) return;

    const dir = new THREE.Vector3();

    if (keys.w || keys.arrowup) dir.z -= 1;
    if (keys.s || keys.arrowdown) dir.z += 1;
    if (keys.a || keys.arrowleft) dir.x -= 1;
    if (keys.d || keys.arrowright) dir.x += 1;

    if (dir.lengthSq()) {
      dir.normalize();

      const f = new THREE.Vector3(
        Math.sin(yaw), 0, Math.cos(yaw)
      );

      const r = new THREE.Vector3(f.z, 0, -f.x);

      camera.position.addScaledVector(
        f, -dir.z * state.speed * dt
      );

      camera.position.addScaledVector(
        r, dir.x * state.speed * dt
      );
    }

    camera.position.y = state.spawn.y;
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
  }

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);

    update(dt);
    updateAtsDoors(dt);
    renderer.render(scene, camera);
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);

    if (previewRenderer && $('preview')) {
      previewRenderer.setSize($('preview').clientWidth, 180);
    }
  }

  function toast(t) {
    $('toast').textContent = t;
    $('toast').style.display = 'block';

    clearTimeout(window._toast);

    window._toast = setTimeout(() => {
      $('toast').style.display = 'none';
    }, 3500);
  }

  init();
})();
