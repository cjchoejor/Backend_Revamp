// LEGPHEL PMS design system — public surface (DSS v1.0).
// The stylesheets are imported once, by the desk layout, in this order:
//   styles/fonts.css · styles/tokens.css · styles/components.css · (legacy theme) · styles/legacy-bridge.css · styles/frame.css
// and <IconSprite /> is mounted once inside the `.ds` root so <Icon> can reference the symbols.
export * from "./components/primitives";
export * from "./components/meaning";
export * from "./components/records";
export { IconSprite } from "./components/sprite";
