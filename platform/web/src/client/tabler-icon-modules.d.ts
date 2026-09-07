// Match Vite's curated export list without duplicating it. Deep icon modules share Tabler's component type.
declare module "@tabler/icons-react/dist/esm/icons/*.mjs" {
  const icon: import("@tabler/icons-react/dist/tabler-icons-react").TablerIcon;
  export default icon;
}
