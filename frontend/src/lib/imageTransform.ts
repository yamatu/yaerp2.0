export type ImageTransform = 'rotate-left' | 'rotate-right' | 'flip-horizontal' | 'flip-vertical'

const OUTPUT_QUALITY = 0.94

function outputMimeType(sourceType: string) {
  const normalized = sourceType.toLowerCase()
  if (normalized === 'image/jpeg' || normalized === 'image/webp' || normalized === 'image/png') {
    return normalized
  }
  return 'image/png'
}

function outputExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  return '.png'
}

function outputFilename(filename: string, mimeType: string) {
  const extension = outputExtension(mimeType)
  const separator = filename.lastIndexOf('.')
  const base = separator > 0 ? filename.slice(0, separator) : filename
  return `${base || 'image'}${extension}`
}

function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('无法读取图片，请确认图片格式受浏览器支持。'))
    }
    image.src = objectUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('图片处理失败，请稍后重试。')),
      mimeType,
      OUTPUT_QUALITY,
    )
  })
}

export async function transformRemoteImage(
  url: string,
  filename: string,
  sourceMimeType: string,
  transform: ImageTransform,
) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error('读取原图片失败，请稍后重试。')
  const sourceBlob = await response.blob()
  const image = await loadImage(sourceBlob)
  const swapsDimensions = transform === 'rotate-left' || transform === 'rotate-right'
  const canvas = document.createElement('canvas')
  canvas.width = swapsDimensions ? image.naturalHeight : image.naturalWidth
  canvas.height = swapsDimensions ? image.naturalWidth : image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片。')

  context.translate(canvas.width / 2, canvas.height / 2)
  if (transform === 'rotate-left') context.rotate(-Math.PI / 2)
  if (transform === 'rotate-right') context.rotate(Math.PI / 2)
  if (transform === 'flip-horizontal') context.scale(-1, 1)
  if (transform === 'flip-vertical') context.scale(1, -1)
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)

  const mimeType = outputMimeType(sourceMimeType || sourceBlob.type)
  const transformedBlob = await canvasToBlob(canvas, mimeType)
  return new File([transformedBlob], outputFilename(filename, mimeType), {
    type: transformedBlob.type || mimeType,
    lastModified: Date.now(),
  })
}

export function imageTransformLabel(transform: ImageTransform) {
  switch (transform) {
    case 'rotate-left':
      return '向左旋转'
    case 'rotate-right':
      return '向右旋转'
    case 'flip-horizontal':
      return '水平翻转'
    case 'flip-vertical':
      return '垂直翻转'
  }
}

export function imageThumbnailUrl(url: string | null | undefined, size = 320) {
  if (!url) return ''
  const [path, query = ''] = url.split('?', 2)
  if (!path.endsWith('/content')) return url
  const normalizedSize = size <= 160 ? 160 : size <= 320 ? 320 : size <= 640 ? 640 : 960
  const search = new URLSearchParams(query)
  search.set('size', String(normalizedSize))
  return `${path.slice(0, -'/content'.length)}/thumbnail?${search.toString()}`
}
