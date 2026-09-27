// Bun turns an imported image into its bundled URL.
declare module "*.png" {
  const url: string;
  export default url;
}
