# OCR language data

`eng.traineddata.gz` is Tesseract's English LSTM model, the integer build of
[tessdata_best](https://github.com/tesseract-ocr/tessdata_best) (Apache-2.0). It
is copied from `4.0.0_best_int/eng.traineddata.gz` in the npm package
`@tesseract.js-data/eng@1.0.0`, the file tesseract.js downloads by default.

sha256 `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`

It ships inside the app so OCR never fetches anything. The electron-vite main
build copies it to `out/main/tessdata/`, and electron-builder unpacks that
folder from `app.asar`.
