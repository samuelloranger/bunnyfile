export function folderNavigationViewTransition(): false | { types: string[] } {
  if (
    typeof CSS === 'undefined' ||
    !CSS.supports('selector(:active-view-transition-type(folder-navigation))')
  ) {
    return false;
  }

  return { types: ['folder-navigation'] };
}
