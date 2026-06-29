import rpc from '../rpc';

const uuidv4 = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const openLayout = (pattern: string, activeUid: string, cloneProfile?: string) => {
  const emitNew = (newUid: string, parentUid: string, direction: 'VERTICAL' | 'HORIZONTAL') => {
    rpc.emit('new', {
      uid: newUid,
      activeUid: parentUid,
      splitDirection: direction,
      isNewGroup: false,
      profile: cloneProfile || 'picker'
    });
  };

  if (pattern === '3cols') {
    const col2 = uuidv4();
    const col3 = uuidv4();
    emitNew(col2, activeUid, 'VERTICAL');
    emitNew(col3, col2, 'VERTICAL');
  } else if (pattern === '3rows') {
    const row2 = uuidv4();
    const row3 = uuidv4();
    emitNew(row2, activeUid, 'HORIZONTAL');
    emitNew(row3, row2, 'HORIZONTAL');
  } else if (pattern === 'grid2x2') {
    const right = uuidv4();
    const leftBottom = uuidv4();
    const rightBottom = uuidv4();
    emitNew(right, activeUid, 'VERTICAL');
    emitNew(leftBottom, activeUid, 'HORIZONTAL');
    emitNew(rightBottom, right, 'HORIZONTAL');
  } else if (pattern === 'leftHeavy') {
    const right = uuidv4();
    const leftBottom = uuidv4();
    emitNew(right, activeUid, 'VERTICAL');
    emitNew(leftBottom, activeUid, 'HORIZONTAL');
  } else if (pattern === 'rightHeavy') {
    const right = uuidv4();
    const rightBottom = uuidv4();
    emitNew(right, activeUid, 'VERTICAL');
    emitNew(rightBottom, right, 'HORIZONTAL');
  } else if (pattern === 'topHeavy') {
    const bottom = uuidv4();
    const topLeft = uuidv4();
    emitNew(bottom, activeUid, 'HORIZONTAL');
    emitNew(topLeft, activeUid, 'VERTICAL');
  } else if (pattern === 'bottomHeavy') {
    const bottom = uuidv4();
    const bottomRight = uuidv4();
    emitNew(bottom, activeUid, 'HORIZONTAL');
    emitNew(bottomRight, bottom, 'VERTICAL');
  } else if (pattern === 'hsplit212') {
    const right = uuidv4();
    const middle = uuidv4();
    const leftBottom = uuidv4();
    const rightBottom = uuidv4();
    emitNew(middle, activeUid, 'VERTICAL');
    emitNew(right, middle, 'VERTICAL');
    emitNew(leftBottom, activeUid, 'HORIZONTAL');
    emitNew(rightBottom, right, 'HORIZONTAL');
  } else if (pattern === 'grid3x2') {
    const middle = uuidv4();
    const right = uuidv4();
    const col1Bottom = uuidv4();
    const col2Bottom = uuidv4();
    const col3Bottom = uuidv4();
    emitNew(middle, activeUid, 'VERTICAL');
    emitNew(right, middle, 'VERTICAL');
    emitNew(col1Bottom, activeUid, 'HORIZONTAL');
    emitNew(col2Bottom, middle, 'HORIZONTAL');
    emitNew(col3Bottom, right, 'HORIZONTAL');
  }
};
