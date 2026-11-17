// Look-and-feel choices platform administrators can make. The files live in public/icons/.
export const THEMES = Object.freeze({ light: 'Light', dark: 'Dark', ocean: 'Ocean', contrast: 'High contrast' });
export const ICONS = Object.freeze({
  classic: 'Package and update (default)', shield: 'Shield with check', box: 'Package box',
  cloud: 'Cloud deploy', bolt: 'Fast patch', gear: 'Managed settings'
});
export const cleanTheme = v => (Object.hasOwn(THEMES, v) ? v : '');
export const cleanIcon = v => (Object.hasOwn(ICONS, v) ? v : 'classic');
export const iconUrl = id => (cleanIcon(id) === 'classic' ? '/favicon.svg' : `/icons/${cleanIcon(id)}.svg`);
