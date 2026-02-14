import {
  loadRemote,
  loadShare,
  registerRemotes,
} from '@module-federation/enhanced/runtime';

type RemoteSpec = {
  name: string;
  entry: string;
};

const registeredEntryByName = new Map<string, string>();

export const ensureRemote = (remote: RemoteSpec) => {
  const prev = registeredEntryByName.get(remote.name);
  if (prev === remote.entry) return;

  // Force lets us replace an already-registered remote and clears the runtime's
  // manifest cache for the previous entry URL (important during dev rebuilds).
  registerRemotes([remote], { force: true });
  registeredEntryByName.set(remote.name, remote.entry);
};

const parseSharedPkgName = (message: string) => {
  const match = message.match(/sharedPkgName\"\s*:\s*\"([^\"]+)\"/);
  return match?.[1] ?? null;
};

export const loadRemoteModule = async <T,>(id: string): Promise<T> => {
  try {
    const mod = await loadRemote<T>(id);
    if (mod == null) throw new Error(`Remote module returned null: ${id}`);
    return mod;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('RUNTIME-006') || msg.includes('Invalid loadShareSync')) {
      const pkg = parseSharedPkgName(msg);
      if (pkg) {
        await loadShare(pkg);
        const mod = await loadRemote<T>(id);
        if (mod == null) throw new Error(`Remote module returned null: ${id}`);
        return mod;
      }
    }

    // If a manifest was previously cached with the wrong publicPath (or a stale
    // build hash), force a re-register and retry once.
    if (msg.includes('RUNTIME-008') || msg.includes("expected expression, got '<'")) {
      const remoteName = id.split('/')[0] || '';
      const entry = remoteName ? registeredEntryByName.get(remoteName) : null;
      if (remoteName && entry) {
        registerRemotes([{ name: remoteName, entry }], { force: true });
        const mod = await loadRemote<T>(id);
        if (mod == null) throw new Error(`Remote module returned null: ${id}`);
        return mod;
      }
    }
    throw err;
  }
};
