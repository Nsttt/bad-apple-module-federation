type Container = {
  init: (shareScope: unknown) => Promise<void> | void;
  get: (module: string) => Promise<() => unknown>;
};

type LoadEntry = {
  url: string;
  script: HTMLScriptElement;
  promise: Promise<void>;
};

const containers = new Map<string, LoadEntry>();

const getSharing = () => {
  const globalScope = globalThis as typeof globalThis & {
    __webpack_init_sharing__?: (scope: string) => Promise<void>;
    __webpack_share_scopes__?: { default?: unknown };
    __rspack_init_sharing__?: (scope: string) => Promise<void>;
    __rspack_share_scopes__?: { default?: unknown };
  };

  return {
    init:
      globalScope.__webpack_init_sharing__ ??
      globalScope.__rspack_init_sharing__,
    scopes:
      globalScope.__webpack_share_scopes__ ??
      globalScope.__rspack_share_scopes__,
  };
};

const loadRemoteEntry = (url: string, scope: string) => {
  const cached = containers.get(scope);
  if (cached) return cached.promise;

  let resolvePromise: () => void;
  let rejectPromise: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const script = document.createElement('script');
  script.src = url;
  script.type = 'text/javascript';
  script.async = true;
  script.onload = () => resolvePromise();
  script.onerror = () => rejectPromise(new Error(`Failed to load remote entry: ${url}`));
  document.head.appendChild(script);

  containers.set(scope, { url, script, promise });
  return promise;
};

const getContainer = async (scope: string) => {
  const container = (window as Window & Record<string, Container>)[scope];
  if (!container) throw new Error(`Container not found: ${scope}`);

  const sharing = getSharing();
  if (typeof sharing.init === 'function' && sharing.scopes?.default) {
    await sharing.init('default');
    await container.init(sharing.scopes.default);
  }

  return container;
};

export const loadRemoteModule = async <T,>({
  url,
  scope,
  module,
}: {
  url: string;
  scope: string;
  module: string;
}): Promise<T> => {
  await loadRemoteEntry(url, scope);
  const container = await getContainer(scope);
  const factory = await container.get(module);
  return factory() as T;
};

export const unloadRemoteContainer = (scope: string) => {
  const entry = containers.get(scope);
  if (!entry) return;
  entry.script.remove();
  try {
    delete (window as Window & Record<string, Container>)[scope];
  } catch {
    // no-op
  }
  containers.delete(scope);
};
