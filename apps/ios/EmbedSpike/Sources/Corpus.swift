import Foundation

/// Deterministic synthetic notes for the corpus-cost run. Lengths follow a
/// log-normal with a 1,500-character median (sigma 1.0), clipped to
/// 40...70,000, so most notes are one window and a few hit the 16-window cap.
/// ASCII only: the core's chunk port counts bytes, desktop counts UTF-16 units.
struct Corpus {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    private mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    private mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }

    private mutating func normal() -> Double {
        let u1 = max(unit(), 1e-12)
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * unit())
    }

    private mutating func word() -> String { Self.words[Int(next() % UInt64(Self.words.count))] }

    mutating func note() -> (title: String, content: String) {
        let target = Int(min(70_000, max(40, exp(log(1_500) + normal()))))
        let title = (0..<(2 + Int(next() % 5))).map { _ in word() }.joined(separator: " ").capitalized
        var body = ""
        while body.count < target {
            var sentence = (0..<(6 + Int(next() % 14))).map { _ in word() }.joined(separator: " ")
            sentence = sentence.prefix(1).uppercased() + sentence.dropFirst() + ". "
            body += sentence
            if next() % 6 == 0 { body += "\n\n" }
        }
        return (title, String(body.prefix(target)))
    }

    static let words: [String] = """
        meeting project deadline review budget design draft follow up client team schedule \
        release feature bug fix note idea plan research summary question answer email call \
        travel flight hotel booking receipt invoice payment tax report quarter goal habit \
        workout recipe grocery list book chapter quote article podcast video lecture course \
        exam homework thesis paper experiment data result chart metric growth user feedback \
        interview hiring onboarding contract lawyer doctor appointment medicine insurance \
        apartment rent move furniture garden weekend family birthday gift party wedding \
        toplanti proje rapor butce tasarim taslak musteri ekip takvim surum hata cozum fikir \
        plan arastirma ozet soru cevap telefon seyahat ucak otel rezervasyon fatura odeme \
        vergi hedef aliskanlik spor tarif market liste kitap bolum alinti makale ders sinav \
        odev tez deney veri sonuc grafik buyume kullanici geri bildirim mulakat sozlesme \
        doktor randevu ilac sigorta ev tasinma bahce hafta sonu aile dogum gunu hediye \
        the a of and to in for with on at from by about into over after before during \
        is was are be have has will would should could can may might must need want \
        today tomorrow yesterday morning evening week month year soon later again always
        """.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
}
