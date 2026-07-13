/**
 * pdfjs-dist v6 espera DOMMatrix/Path2D/ImageData no escopo global já na
 * avaliação do módulo e, na ausência, tenta carregar "@napi-rs/canvas" —
 * um binário nativo POR PLATAFORMA que não pode ir num .mcpb multiplataforma.
 * O Case File só extrai TEXTO (getTextContent), nunca renderiza; stubs
 * mínimos construíveis bastam. Este módulo DEVE ser importado antes do pdfjs.
 */

class DOMMatrixStub {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
  }

  scale(): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]);
  }

  translate(): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]);
  }

  multiply(): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]);
  }
}

class Path2DStub {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  rect(): void {}
  closePath(): void {}
}

class ImageDataStub {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const g = globalThis as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrixStub;
g.Path2D ??= Path2DStub;
g.ImageData ??= ImageDataStub;

export {};
