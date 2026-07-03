/// <reference types="vite/client" />

// Vite worker imports (`?worker`) resolve to a Worker constructor.
declare module '*?worker' {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
