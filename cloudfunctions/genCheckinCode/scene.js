const SCENE_PATTERN = /^[0-9A-Za-z!#$&'()*+,/:;=?@\-._~]+$/;

function compactHexId(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return '';
  return Buffer.from(value, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function validateScene(scene) {
  if (scene.length > 32 || !SCENE_PATTERN.test(scene)) {
    throw new Error('门店或球桌标识无法生成有效桌码');
  }
  return scene;
}

function buildScene(storeId, tableId) {
  const direct = `s=${storeId}&t=${tableId}`;
  if (direct.length <= 32 && SCENE_PATTERN.test(direct)) return direct;

  const compactStoreId = compactHexId(storeId);
  if (!compactStoreId) throw new Error('门店标识过长，无法生成桌码');
  return validateScene(`h=${compactStoreId}&t=${tableId}`);
}

module.exports = { buildScene };
