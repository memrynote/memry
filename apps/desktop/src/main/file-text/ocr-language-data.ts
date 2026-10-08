import type { OcrLanguage } from '@memry/contracts/ocr-languages-api'

/**
 * The data the sync server serves at /ocr/v1/<lang>.traineddata.gz, pinned to
 * its exact bytes: `ocr/v1/manifest.json` as apps/sync-server/scripts/upload-ocr-language-data.ts
 * writes it. A download is used only when it matches. English ships with the app.
 */
export const OCR_LANGUAGE_DATA: Record<
  Exclude<OcrLanguage, 'eng'>,
  { bytes: number; sha256: string }
> = {
  ara: {
    bytes: 715721,
    sha256: '090272d40d936ad88972221b4de9ccbf0bd4fcfb3f4560324456d02a1b9fa601'
  },
  ces: {
    bytes: 1717937,
    sha256: '6bfadc58cefc062db38dec6c66f071309c6c8254d87b8c3244b2ff40a26ed3f8'
  },
  chi_sim: {
    bytes: 1722294,
    sha256: '02195fba04d554ccd4eed4c444d17a9f8360ecbbf3d50829ab8935880a0b342c'
  },
  chi_tra: {
    bytes: 1662934,
    sha256: 'fd8c68871f99a104fe6daddd696a3b48e791c5ee850274b9fd91e94bdae586f6'
  },
  dan: {
    bytes: 1255263,
    sha256: 'adf2983adf8ebdf4ead69c15862cf5471283ca0295078d895a1644ca0c6721a4'
  },
  deu: {
    bytes: 850091,
    sha256: '7bd23948a6a5ad1771138902d67fa1d4f684bbde2783f01c1ac31fa2b8beb5bf'
  },
  ell: {
    bytes: 700115,
    sha256: '2d22a6af29ce24ddd24241f3394ad6dfb300340be407b7242023efeb7fc8aea2'
  },
  fil: {
    bytes: 907783,
    sha256: '7fe0669b74a05e7f4f00447d6ac72eb374ddbab6bbc2cbae33289320b862314a'
  },
  fin: {
    bytes: 3750554,
    sha256: 'a6770d0b84ef485f3344cd927a1d7508cecfb089ac9f8eeb0c62bc5e8de651c8'
  },
  fra: {
    bytes: 605839,
    sha256: '64c1600872b3597be680c698d9d378d295c05cadc0c92f9047d0256ce6992f9f'
  },
  heb: {
    bytes: 475824,
    sha256: '6ba00d0bc3adfa1a02b4016b5ea16d12622b505a99f7b3c7b800366c70051b83'
  },
  hrv: {
    bytes: 1766831,
    sha256: 'bb960534adba1829a628d5fd1e7af7df4d7f1a9f181a36fd1623652b28533432'
  },
  hun: {
    bytes: 2339289,
    sha256: 'd9c38bd919bc0cbf368d71b9d7512f8599a19c3f2f113e012ac5fefb1eb0b995'
  },
  ind: {
    bytes: 607367,
    sha256: 'b5a844a8181c16322f6547a2d02c648c9572e1dec563820de9e65d3ed4b44f76'
  },
  ita: {
    bytes: 1269108,
    sha256: '6377e1f1ce5118cf88f90298f655e6f0f2299f8d1905d58fb349385eef3db3e2'
  },
  jpn: {
    bytes: 1518264,
    sha256: '3f15c0429e57c9c0a71f9366a9a8ffc8d4af756de2ce1a4fd66d90291de6385a'
  },
  kor: {
    bytes: 1103423,
    sha256: 'f67c2e56d0a311f824f707d74a1ec190afca0ffaa8b415b3745e3769eca19db2'
  },
  msa: {
    bytes: 1181116,
    sha256: '6eda11cc9fe87f11a87febfa7f717b9036d6659e6f00fc0888e2de3fa4a3230c'
  },
  nld: {
    bytes: 2958034,
    sha256: '0cb6d734ed2d15cef2143340bcf8087bc4ed4cf265304e0ee91dfecfedc64999'
  },
  nor: {
    bytes: 2018918,
    sha256: '6af3c2aa7cdeafe4b531215789b648cf3b1ecd821327e753c96df02703f9fb84'
  },
  pol: {
    bytes: 2020138,
    sha256: '1ca444dfab4547e2e4b17862631dc099ede8f81397a11d036067e50fa36947e6'
  },
  por: {
    bytes: 998523,
    sha256: '346593e8ae26653df361a98dcdb931d8925fa5873b9637e7b4ec3670d336ccee'
  },
  ron: {
    bytes: 1079514,
    sha256: '9872895b6cb83763a46443d2df131acbe95ce5f839f1a2a20774acab70d5366e'
  },
  rus: {
    bytes: 1594493,
    sha256: '3404b2e431d8a33504a1c982c651490bae4f6913ea781db3c19a70ba44867000'
  },
  slk: {
    bytes: 1859992,
    sha256: 'e5e8324321cc29371909c1fb4a184096692c8cd5c68c27801c3cfc4db524f3e3'
  },
  spa: {
    bytes: 1125535,
    sha256: '5e3dc4a78d5dcc2368f012c936824b9dcb718162a98729a1cdcd444518f5bb6f'
  },
  swe: {
    bytes: 2505337,
    sha256: 'd90d0f7f9587dd94b71a3a83d432592958da3910913777dddb26828c4bffee84'
  },
  tha: {
    bytes: 905028,
    sha256: '4ca992fdea7c36768a34515c95ec04a4500f1cd0cc48f9dcf3a45d8e688f3e02'
  },
  tur: {
    bytes: 1998077,
    sha256: 'e5e022aa5c370f25d954c047467f8fa7d057250402a97a2d867e5615b7cf44de'
  },
  ukr: {
    bytes: 1606606,
    sha256: 'aac81769d4957414bde2fe26f98e49faa6d0acf712c05b80bc3d7fd9be5733a0'
  },
  vie: { bytes: 422083, sha256: 'a5b0819fc13d4e341784b933434deccf67c4df79eff3ac0877fe8a94624c8c3b' }
}
