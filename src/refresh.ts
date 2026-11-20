export interface RefreshViewsOptions {
  installed?: () => Promise<void> | void;
  market?: () => Promise<void> | void;
  panel: () => void;
}

export async function refreshViews(
  options: RefreshViewsOptions
): Promise<void> {
  try {
    await options.installed?.();
    await options.market?.();
  } finally {
    options.panel();
  }
}
