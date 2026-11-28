// Plans: what each account may do. The relay is the authority (server/plus.js); the client reads
// the same table to explain the plans.
//
// Uploads: one-to-one and small-group media still travel inside end-to-end encrypted envelopes
// (shared/chat.js MAX_MEDIA_BYTES). `uploadBytes` is the size of one post in a large group or
// channel, where the relay keeps a single (encrypted, for private spaces) copy. `storageBytes` caps
// all of one account's posts there together; deleting a post frees its space.

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const TIERS = {
  free: {
    id: 'free', name: 'FabriC++', priceLabel: 'Free',
    uploadBytes: 1 * MB, storageBytes: 1 * GB, devices: 5, groupMembers: 1_000, ownedChannels: 10, ads: true, badge: false,
  },
  plus: {
    id: 'plus', name: 'FabriC++ Plus', priceLabel: '$4.99 / month',
    uploadBytes: 8 * MB, storageBytes: 20 * GB, devices: 10, groupMembers: 20_000, ownedChannels: 100, ads: false, badge: true,
  },
};
export const TIER_IDS = Object.keys(TIERS);
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(TIERS).map((t) => t.uploadBytes));
export const tierOf = (id) => TIERS[id] || TIERS.free;

/** Rows for the plan comparison, in the order the client shows them. */
export function compareRows(fmtBytes = (n) => `${Math.round(n / MB)} MB`) {
  const f = TIERS.free, p = TIERS.plus;
  return [
    ['Post size in large groups and channels', fmtBytes(f.uploadBytes), fmtBytes(p.uploadBytes)],
    ['Storage for your posts there', `${f.storageBytes / GB} GB`, `${p.storageBytes / GB} GB`],
    ['Devices on one account', String(f.devices), String(p.devices)],
    ['Members in a large group you own', f.groupMembers.toLocaleString('en-US'), p.groupMembers.toLocaleString('en-US')],
    ['Channels you own', String(f.ownedChannels), String(p.ownedChannels)],
    ['Sponsored posts', 'Contextual, capped', 'None'],
    ['Plus mark on your profile', '—', 'Yes'],
  ];
}
