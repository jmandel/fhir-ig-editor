// TYPECHECK-ONLY stub for the read-only cycle site-gen submodule. tsconfig `paths`
// maps every `*/vendor/cycle/site-gen/*` import to this module so app-side `tsc`
// does NOT descend into the submodule (which is authored against its own loose
// tsconfig + node_modules and is not ours to typecheck). At BUILD time Vite's
// `resolve` uses the real files (and the core/db alias); esbuild transpiles them
// without typechecking. So this stub only satisfies the type layer.
//
// Every named import the M2 renderer uses is declared here as `any`.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Crumb = any;
export type TocItem = any;
export type ProfileRequirement = any;
export type ProfileExampleUse = any;
export type ResolveType = any;

export const Layout: any = undefined;
export const ProfilePage: any = undefined;
export const ArtifactsPage: any = undefined;
export const ValueSetPage: any = undefined;
export const CodeSystemPage: any = undefined;
export const ExamplePage: any = undefined;
export const ResourcePage: any = undefined;
export const renderResourceFragment: any = undefined;
export const renderLiquid: any = undefined;
export const includes: any = undefined;
export const renderMarkdown: any = undefined;
export const sanitizeMarkdownSource: any = undefined;
export const project: any = undefined;
