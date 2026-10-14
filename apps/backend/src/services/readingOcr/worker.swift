import Foundation
import PDFKit
import Vision
import CoreGraphics

struct OcrFailure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw OcrFailure(code: code, message: message) }
func emit(_ value: [String: Any]) throws { let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
func number(_ input: [String: Any], _ key: String) throws -> Double {
    guard let value = input[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { try fail("OCR_INPUT_INVALID", "Invalid numeric field: \(key)") }
    return value.doubleValue
}
func imageContext(_ width: Int, _ height: Int) throws -> CGContext {
    guard width > 0, height > 0, width <= 6000, height <= 6000, width * height <= 12_000_000,
      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { try fail("OCR_IMAGE_LIMIT", "OCR image exceeds fixed pixel limits") }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context
}
do {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = false
    let languages = try request.supportedRecognitionLanguages()
    if CommandLine.arguments.dropFirst().elementsEqual(["capabilities"]) {
        try emit(["available": true, "engine": "apple-vision", "revision": request.revision, "languages": languages]); exit(0)
    }
    guard CommandLine.arguments.dropFirst().elementsEqual(["recognize"]) else { try fail("OCR_INPUT_INVALID", "Only the fixed recognize/capabilities commands are available") }
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard bytes.count <= 8192, let input = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(input.keys) == Set(["pdfPath", "page", "region", "rotation", "language"]),
      let pdfPath = input["pdfPath"] as? String, pdfPath.hasPrefix("/"), pdfPath.lowercased().hasSuffix(".pdf"),
      let region = input["region"] as? [String: Any], Set(region.keys) == Set(["x", "y", "width", "height"]), let language = input["language"] as? String else { try fail("OCR_INPUT_INVALID", "Invalid fixed OCR input") }
    let pageNumber = try number(input, "page"), rotation = try number(input, "rotation")
    let x = try number(region, "x"), y = try number(region, "y"), width = try number(region, "width"), height = try number(region, "height")
    guard pageNumber.rounded() == pageNumber, pageNumber >= 1, pageNumber <= 10000, [0.0, 90, 180, 270].contains(rotation), x >= 0, y >= 0, width > 0, height > 0, x + width <= 1, y + height <= 1 else { try fail("OCR_INPUT_INVALID", "Invalid PDF page, normalized region or rotation") }
    let aliases = ["en": "en-US", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant"]
    if language == "auto" { request.automaticallyDetectsLanguage = true }
    else { let selected = aliases[language] ?? language; guard languages.contains(selected) else { try fail("OCR_LANGUAGE_UNAVAILABLE", "This local OCR language is unavailable") }; request.recognitionLanguages = [selected] }
    guard let document = PDFDocument(url: URL(fileURLWithPath: pdfPath)), !document.isLocked, document.pageCount <= 10000,
      pageNumber <= Double(document.pageCount), let page = document.page(at: Int(pageNumber) - 1), let reference = page.pageRef else { try fail("OCR_PDF_INVALID", "PDF is unavailable, locked, invalid or page is outside the document") }
    let media = reference.getBoxRect(.mediaBox)
    guard !media.isEmpty, media.width.isFinite, media.height.isFinite, media.width <= 14400, media.height <= 14400 else { try fail("OCR_PDF_INVALID", "Invalid PDF mediaBox") }
    // PDF.js page.view uses the unrotated CropBox intersected with MediaBox.
    // A missing/invalid intersection falls back to MediaBox, as PDF.js does.
    let crop = reference.getBoxRect(.cropBox), intersection = media.intersection(crop)
    let visible = intersection.isNull || intersection.isEmpty ? media : intersection
    let cropWidth = visible.width * width, cropHeight = visible.height * height
    let scale = min(3.0, min(6000.0 / cropWidth, min(6000.0 / cropHeight, sqrt(11_980_000.0 / (cropWidth * cropHeight)))))
    let pixelWidth = Int(ceil(cropWidth * scale)), pixelHeight = Int(ceil(cropHeight * scale))
    let bitmap = try imageContext(pixelWidth, pixelHeight)
    bitmap.scaleBy(x: scale, y: scale)
    bitmap.translateBy(x: -(visible.minX + visible.width * x), y: -(visible.minY + visible.height * (1 - y - height)))
    // drawPDFPage uses raw PDF coordinates. Do NOT apply page.rotation here:
    // the client supplied the actual total viewer rotation, which is applied once below.
    bitmap.drawPDFPage(reference)
    guard let base = bitmap.makeImage() else { try fail("OCR_RENDER_FAILED", "PDF region could not be rendered") }
    let rotatedWidth = rotation == 90 || rotation == 270 ? pixelHeight : pixelWidth
    let rotatedHeight = rotation == 90 || rotation == 270 ? pixelWidth : pixelHeight
    let oriented = try imageContext(rotatedWidth, rotatedHeight)
    oriented.translateBy(x: Double(rotatedWidth) / 2, y: Double(rotatedHeight) / 2)
    oriented.rotate(by: -rotation * .pi / 180)
    let centeredImage = CGRect(x: -Double(pixelWidth) / 2.0, y: -Double(pixelHeight) / 2.0, width: Double(pixelWidth), height: Double(pixelHeight))
    oriented.draw(base, in: centeredImage)
    guard let image = oriented.makeImage() else { try fail("OCR_RENDER_FAILED", "Rotated region could not be rendered") }
    try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
    var lines: [[String: Any]] = []
    for result in request.results ?? [] {
        guard let candidate = result.topCandidates(1).first else { continue }
        let rect = result.boundingBox
        lines.append(["text": candidate.string, "confidence": candidate.confidence, "rect": ["x": rect.minX, "y": 1 - rect.maxY, "width": rect.width, "height": rect.height]])
    }
    guard lines.count <= 2000 else { try fail("OCR_OUTPUT_LIMIT", "Too many recognized lines") }
    let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
    guard text.utf8.count <= 100000 else { try fail("OCR_OUTPUT_LIMIT", "Recognized text exceeds output limits") }
    try emit(["text": text, "lines": lines, "engine": "apple-vision", "revision": request.revision, "language": language, "recognitionLanguages": request.recognitionLanguages,
      "width": rotatedWidth, "height": rotatedHeight, "basis": "crop-image-top-left-normalized", "pdfRotation": reference.rotationAngle, "rotation": Int(rotation), "pageBox": "cropbox-mediabox-intersection", "visibleBox": ["x": visible.minX, "y": visible.minY, "width": visible.width, "height": visible.height]])
} catch {
    let known = error as? OcrFailure
    try? emit(["error": ["code": known?.code ?? "OCR_ENGINE_FAILED", "message": known?.message ?? String(describing: error)]])
    exit(1)
}
