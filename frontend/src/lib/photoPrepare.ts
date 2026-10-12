const MAX_EDGE = 2560
const JPEG_QUALITY = 0.86

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Bakes the EXIF orientation so phone photos are upright everywhere,
      // including server-side thumbnails that ignore EXIF.
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Older Safari rejects the options bag; fall back to <img>, which also
      // honours EXIF orientation in current browsers.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`无法读取图片 ${file.name}`))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Normalises a camera/album photo before upload: applies EXIF orientation plus
 * an extra clockwise rotation (0/90/180/270), and downsizes to a sensible
 * resolution so uploads from phones stay fast.
 */
export async function preparePhoto(file: File, rotation = 0): Promise<File> {
  const turns = (((Math.round(rotation / 90) % 4) + 4) % 4)
  const source = await decode(file)
  const sourceWidth = 'naturalWidth' in source ? source.naturalWidth : source.width
  const sourceHeight = 'naturalHeight' in source ? source.naturalHeight : source.height
  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight))
  const width = Math.round(sourceWidth * scale)
  const height = Math.round(sourceHeight * scale)
  const swap = turns % 2 === 1
  const canvas = document.createElement('canvas')
  canvas.width = swap ? height : width
  canvas.height = swap ? width : height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法处理图片')
  context.translate(canvas.width / 2, canvas.height / 2)
  context.rotate((turns * Math.PI) / 2)
  context.drawImage(source, -width / 2, -height / 2, width, height)
  if ('close' in source) source.close()
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('图片处理失败'))), 'image/jpeg', JPEG_QUALITY),
  )
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo'
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}
