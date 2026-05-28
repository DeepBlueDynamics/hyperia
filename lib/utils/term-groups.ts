import type {ITermState} from '../../typings/hyper';

export default function findBySession(termGroupState: ITermState, sessionUid: string) {
  const {termGroups} = termGroupState;
  return Object.keys(termGroups)
    .map((uid) => termGroups[uid])
    .find((group) => group.sessionUid === sessionUid);
}

export function countHorizontalStacks(groupUid: string, termGroups: Record<string, any>): number {
  const group = termGroups[groupUid];
  if (!group) return 0;
  if (!group.children || group.children.length === 0) return 1;
  if (group.direction === 'HORIZONTAL') {
    return group.children.reduce((total: number, childUid: string) => total + countHorizontalStacks(childUid, termGroups), 0);
  } else {
    return Math.max(...group.children.map((childUid: string) => countHorizontalStacks(childUid, termGroups)));
  }
}

export function countPathHorizontalStacks(groupUid: string, termGroups: Record<string, any>): number {
  let currentUid = groupUid;
  let stacks = 1;
  while (currentUid) {
    const group = termGroups[currentUid];
    if (!group) break;
    const parentUid = group.parentUid;
    if (!parentUid) break;
    const parent = termGroups[parentUid];
    if (parent && parent.direction === 'HORIZONTAL') {
      for (const childUid of parent.children) {
        if (childUid !== currentUid) {
          stacks += countHorizontalStacks(childUid, termGroups);
        }
      }
    }
    currentUid = parentUid;
  }
  return stacks;
}

