/** Simple binding to an AI language model. */
export interface LanguageModelBinding {
  /**
   * Run the model with text and optional images, returning generated text. Images must be
   * PNG, JPEG or WebP encoded as plain Base64 (not a URL or data URL), at most 4 MiB each,
   * 5 MiB total and five images. Image input requires a vision-capable model.
   */
  run(options: {
    prompt: string;
    systemPrompt?: string;
    images?: ModelImage[];
  }): Promise<string>;
}

/** A model image sent as bytes, without fetching any user-supplied URL. */
export type ModelImage = {
  /** The actual image encoding: PNG, JPEG or WebP. */
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** Canonical, padded Base64 of the original image bytes, without a data URL prefix. */
  data: string;
};

/** A dedicated image-reading capability using the owner's configured language model. */
export interface OcrModelBinding {
  /** Read one to five images (4 MiB each, 5 MiB total); defaults to verbatim transcription. */
  readImages(options: {
    images: ModelImage[];
    prompt?: string;
    systemPrompt?: string;
  }): Promise<string>;
}
