declare module "heic-decode" {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  interface PendingImage {
    width: number;
    height: number;
    decode(): Promise<DecodedImage>;
  }

  interface PendingImages extends Array<PendingImage> {
    dispose(): void;
  }

  function decode(options: { buffer: Buffer }): Promise<DecodedImage>;
  namespace decode {
    function all(options: { buffer: Buffer }): Promise<PendingImages>;
  }
  export default decode;
}
