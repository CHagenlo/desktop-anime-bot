export function validateVrm(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.length > 50 * 1024 * 1024) throw new Error('Choose a self-contained VRM file smaller than 50 MB.');
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) throw new Error('The avatar must be a binary glTF 2 VRM file.');
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || jsonLength > buffer.length - 20) throw new Error('The VRM model is not valid.');
  let model;
  try { model = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8')); }
  catch { throw new Error('The avatar contains invalid model metadata.'); }
  if (!model.extensions || (!model.extensions.VRMC_vrm && !model.extensions.VRM)) throw new Error('This file does not contain a VRM avatar.');
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === 'uri' && typeof child === 'string' && !child.startsWith('data:')) throw new Error('The avatar references an external file. Export a self-contained VRM model.');
      if (typeof child === 'object') inspect(child);
    }
  }
  inspect(model);
  return model;
}
