/// <reference types="vite/client" />

// Vite worker imports (`?worker`) resolve to a Worker constructor.
declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare const __CYCLE_RENDER_RECIPE__: string;
declare const __ENGINE_RECIPE__: string;
