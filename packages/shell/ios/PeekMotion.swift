import QuartzCore

final class PeekMotion {
  enum Phase: String { case idle, waiting, entering, open, gesture, settling, closing, promoting, finished }
  enum Entrance: String { case genie, affine, fade }
  enum Outcome: String { case closed, promoted }
  enum PinchOutcome: String { case open, close, stay }

  static let openAt = 0.3
  static let closeAt = -0.25
  static let spreadToTab = 0.4
  static let fullAt = 1.2
  static var promoted: Double { spreadToTab * fullAt }
  static let readyTimeout = 0.15
  static let fadeSeconds = 0.15
  static let rows = 36
  static let columns = 4
  static let genieResponse = 0.26
  static let closeResponse = 0.26
  static let genieRest = 0.004
  static let neckWidth = 0.12
  static let rowLag = 0.5
  static let squeezeLead = 0.4
  static let fadeTail = 0.12
  static let startScale = 0.12
  static let smallestScale = 0.5

  private(set) var phase = Phase.idle
  private(set) var generation = 0
  private(set) var entrance = Entrance.genie
  private(set) var interrupted = false
  private(set) var readyTimedOut = false
  private(set) var geometry = PeekGeometry.empty
  var reduce = false
  var canWarp = true
  var slow = 1.0

  private var m = PeekSpring(value: 0, response: 0.2)
  private var presence = PeekSpring(value: 1, response: 0.26)
  private var warp = PeekSpring(value: 0, response: 0.22)
  private var residual: [CGPoint] = []
  private var alphaResidual = 0.0
  private var scrimResidual = 0.0
  private var fade = (from: 1.0, to: 1.0, start: 0.0)
  private var genieStart = 0.0
  private var closeStart = 0.0
  private var closeCard = PeekAffine.identity
  private var closeFrom: [CGPoint] = []
  private var closeOffsets: [CGPoint] = []
  private var closeAlpha = 1.0
  private var closeScrim = 1.0
  private var closeChrome = 1.0
  private var committed: PeekFrame?
  private var committedAt = 0.0
  private var waitingSince = 0.0
  private var gestureBase = 0.0
  private var gestureSample = (t: 0.0, m: 0.0)
  private var outcome: Outcome?
  private var reported = false
  private var clock = 0.0

  var animating: Bool { [.waiting, .entering, .gesture, .settling, .closing, .promoting].contains(phase) }
  var terminal: Bool { [.idle, .closing, .promoting, .finished].contains(phase) }
  var warpingEntrance: Bool { phase == .entering && entrance == .genie }
  var warpingClose: Bool { phase == .closing && !closeFrom.isEmpty }
  var lastCommitAt: Double { committedAt }

  func commit(_ frame: PeekFrame, at now: Double) {
    committed = frame
    committedAt = now
  }
  var expansion: Double { m.value }

  func begin(_ generation: Int, at now: Double) -> Bool {
    guard generation > self.generation else { return false }
    self.generation = generation
    phase = .waiting
    entrance = reduce ? .fade : .genie
    interrupted = false
    readyTimedOut = false
    m.jump(0)
    presence.jump(1)
    warp.jump(0)
    clearResidual()
    fade = (1, 1, now)
    outcome = nil
    reported = false
    committed = nil
    closeFrom = []
    closeOffsets = []
    waitingSince = now
    clock = now
    return true
  }

  func setGeometry(_ next: PeekGeometry, at now: Double) {
    guard next != geometry else { return }
    let first = !geometry.valid
    geometry = next
    if first { return }
    switch phase {
    case .entering, .gesture, .settling: snapOpen(at: now)
    case .closing: finish(.closed)
    case .promoting: finish(.promoted)
    default: break
    }
  }

  func markReady(at now: Double) {
    if phase == .waiting, geometry.valid { startEntrance(at: now) }
  }

  func fallBack(at now: Double) {
    guard warpingEntrance else { return }
    entrance = .affine
    presence.jump(0)
    presence.aim(1, response: 0.26)
    genieStart = now
  }

  func cancel() {
    phase = .finished
    outcome = nil
    reported = true
  }

  func takeOutcome() -> Outcome? {
    guard !reported, let outcome else { return nil }
    reported = true
    return outcome
  }

  func close(at now: Double) -> Bool {
    if terminal { return false }
    clock = now
    if phase == .waiting {
      finish(.closed)
      return true
    }
    let shown = committed
    freeze(at: now)
    phase = .closing
    if reduce {
      fade = (fadeValue(now), 0, now)
    } else if canWarp, let shown, geometry.valid, !geometry.fullscreen {
      startGenieClose(from: shown, at: clock)
    } else {
      presence.aim(0, response: 0.2)
      m.aim(min(m.value, 0), response: 0.2)
    }
    return true
  }

  func promote(at now: Double) -> Bool {
    if terminal { return false }
    clock = now
    if phase == .waiting {
      entrance = .affine
      presence.jump(reduce ? 1 : 0)
    }
    freeze(at: now)
    phase = .promoting
    if reduce {
      m.jump(Self.promoted)
      presence.jump(1)
      warp.jump(0)
      clearResidual()
      fade = (1, 1, now)
    } else {
      m.aim(Self.promoted, response: 0.22)
      presence.aim(1, response: 0.22)
    }
    return true
  }

  func gestureBegan(at now: Double) -> Bool {
    switch phase {
    case .entering:
      clock = now
      freeze(at: now)
    case .open, .settling:
      clock = now
    case .gesture: break
    default: return false
    }
    phase = .gesture
    gestureBase = m.value
    m.aim(m.value)
    m.velocity = 0
    gestureSample = (now, m.value)
    return true
  }

  func gestureChanged(_ total: Double, at now: Double) {
    guard phase == .gesture, !reduce else { return }
    let value = min(max(gestureBase + total, -1), 1.2)
    let dt = now - gestureSample.t
    if dt > 0.001 { m.velocity = 0.6 * m.velocity + 0.4 * (value - gestureSample.m) / dt }
    m.value = value
    m.target = value
    gestureSample = (now, value)
  }

  func gestureEnded(_ total: Double, cancelled: Bool, at now: Double) -> PinchOutcome {
    guard phase == .gesture else { return .stay }
    let value = gestureBase + total
    let result: PinchOutcome = cancelled ? .stay : value >= Self.openAt ? .open : value <= Self.closeAt ? .close : .stay
    switch result {
    case .open: _ = promote(at: now)
    case .close: _ = close(at: now)
    case .stay:
      phase = .settling
      m.aim(0, response: 0.2)
    }
    return result
  }

  func advance(to now: Double) {
    let dt = max(0, now - clock)
    clock = now
    switch phase {
    case .waiting:
      if geometry.valid, now - waitingSince >= Self.readyTimeout {
        readyTimedOut = true
        startEntrance(at: now)
      }
    case .entering:
      switch entrance {
      case .genie: if entranceP(now) <= Self.genieRest { snapOpen(at: now) }
      case .affine:
        presence.step(dt)
        if presence.settled(within: 1e-3) { snapOpen(at: now) }
      case .fade: if fadeValue(now) >= 1 { snapOpen(at: now) }
      }
    case .gesture:
      warp.step(dt)
      presence.step(dt)
    case .settling:
      warp.step(dt)
      presence.step(dt)
      m.step(dt)
      if m.settled(within: 5e-4), warp.settled(within: 1e-3), presence.settled(within: 1e-3) { snapOpen(at: now) }
    case .closing:
      if warpingClose {
        if closeP(now) >= 1 - Self.genieRest { finish(.closed) }
      } else {
        warp.step(dt)
        m.step(dt)
        presence.step(dt)
        if reduce ? fadeValue(now) <= 0 : presence.value <= 0.02 { finish(.closed) }
      }
    case .promoting:
      if reduce {
        if now - fade.start >= Self.fadeSeconds { finish(.promoted) }
      } else {
        warp.step(dt)
        m.step(dt)
        presence.step(dt)
        if m.settled(within: 4e-4), presence.settled(within: 1e-3), warp.settled(within: 1e-3) {
          m.jump(Self.promoted)
          presence.jump(1)
          warp.jump(0)
          clearResidual()
          finish(.promoted)
        }
      }
    default: break
    }
    if warp.target == 0, abs(warp.value) < 1e-4, !residual.isEmpty {
      warp.jump(0)
      clearResidual()
    }
  }

  func frame(at now: Double) -> PeekFrame {
    var f = PeekFrame()
    let g = geometry
    guard g.valid else { return f }
    let base = PeekAffine.mapping(g.page, to: g.rest)
    if g.fullscreen || (phase == .finished && outcome == .promoted) {
      f.cardAlpha = 1
      f.chromeAlpha = 0
      f.topRadius = g.fullscreen ? 0 : g.tabTopRadius
      f.bottomRadius = g.fullscreen ? 0 : g.tabBottomRadius
      f.shownPage = g.page
      return f
    }
    f.topRadius = g.restRadius
    f.bottomRadius = g.restRadius
    if phase == .waiting || phase == .idle || (phase == .finished && outcome != .promoted) {
      f.page = base
      f.shownPage = g.rest
      return f
    }
    if warpingClose {
      let p = closeP(now)
      let shrink = closeCard.apply(g.card)
      f.card = closeCard
      f.page = base.then(closeCard)
      f.shownPage = f.page.apply(g.page)
      f.from = closeFrom
      let funnel = funnelGrid(card: shrink, p: p)
      f.to = zip(funnel, closeOffsets).map { CGPoint(x: $0.x + $1.x * (1 - p), y: $0.y + $1.y * (1 - p)) }
      f.cardAlpha = closeAlpha * Self.unit((1 - p) / Self.fadeTail)
      f.scrimAlpha = closeScrim * (1 - p)
      f.chromeAlpha = closeChrome
      f.residual = 1
      return f
    }
    if warpingEntrance {
      let p = entranceP(now)
      f.page = base
      f.from = restGrid()
      f.to = funnelGrid(card: g.card, p: p)
      f.cardAlpha = Self.unit((1 - p) / Self.fadeTail)
      f.scrimAlpha = 1 - p
      f.residual = 1
      f.shownPage = g.rest
      return f
    }
    let mv = m.value
    let e = mv >= 0 ? Self.rubber(mv / Self.spreadToTab) : 0
    let expand: PeekAffine = mv >= 0 ? .mapping(g.rest, to: Self.lerp(g.rest, g.page, e)) : .scale(max(Self.smallestScale, 1 + mv), about: Self.center(g.card))
    let a = presence.value
    let cs = Self.center(g.card), ss = Self.center(g.source)
    let gs = Self.lerp(Self.startScale, 1, a)
    let to = CGPoint(x: Self.lerp(ss.x, cs.x, a), y: Self.lerp(ss.y, cs.y, a))
    let card = expand.then(PeekAffine(s: gs, tx: to.x - gs * cs.x, ty: to.y - gs * cs.y))
    f.card = card
    f.page = base.then(card)
    f.shownPage = f.page.apply(g.page)
    let ec = Self.unit(e)
    let presenceAlpha = a < 0.35 ? max(0, a) / 0.35 : 1
    let pinchAlpha = mv < 0 ? Self.unit(1 + 1.6 * mv) : 1
    let fv = fadeValue(now)
    f.cardAlpha = Self.unit(presenceAlpha * pinchAlpha * fv + alphaResidual * warp.value)
    f.chromeAlpha = Self.unit(1 - 1.6 * ec)
    f.scrimAlpha = Self.unit(Self.unit(a) * (mv >= 0 ? 1 - ec : Self.unit(1 + 2 * mv)) * fv + scrimResidual * warp.value)
    if reduce && phase == .promoting {
      let p = Self.unit((now - fade.start) / Self.fadeSeconds)
      f.cardAlpha = 1
      f.chromeAlpha = 0
      f.scrimAlpha = 1 - p
    }
    f.topRadius = Self.lerp(g.restRadius, g.tabTopRadius, ec)
    f.bottomRadius = Self.lerp(g.restRadius, g.tabBottomRadius, ec)
    if warp.value > 1e-4, residual.count == (Self.rows + 1) * (Self.columns + 1) {
      let rest = restGrid()
      let w = warp.value
      f.from = rest.map(card.apply)
      f.to = zip(rest, residual).map { card.apply(CGPoint(x: $0.x + $1.x * w, y: $0.y + $1.y * w)) }
      f.residual = w
    }
    return f
  }

  private func startEntrance(at now: Double) {
    phase = .entering
    if reduce {
      entrance = .fade
      fade = (0, 1, now)
    } else if canWarp, geometry.valid, !geometry.fullscreen {
      entrance = .genie
      genieStart = now
    } else {
      entrance = .affine
      presence.jump(0)
      presence.aim(1, response: 0.26)
    }
  }

  private func freeze(at now: Double) {
    guard phase == .entering else { return }
    interrupted = true
    guard entrance == .genie else { return }
    let at = committed != nil ? committedAt : now
    let p = entranceP(at)
    let rest = restGrid()
    let shown = committed.flatMap { $0.to.count == rest.count ? $0 : nil }
    residual = zip(shown?.to ?? funnelGrid(card: geometry.card, p: p), rest).map { CGPoint(x: $0.x - $1.x, y: $0.y - $1.y) }
    alphaResidual = (shown?.cardAlpha ?? Self.unit((1 - p) / Self.fadeTail)) - 1
    scrimResidual = (shown?.scrimAlpha ?? 1 - p) - 1
    clock = at
    let w = 2 * Double.pi / (Self.genieResponse * slow), t = at - genieStart
    let rate = p > 1e-6 ? -w * w * t / (1 + w * t) : 0
    warp.jump(1)
    warp.velocity = rate
    warp.aim(0, response: 0.22)
    entrance = .affine
    presence.jump(1)
  }

  private func startGenieClose(from shown: PeekFrame, at now: Double) {
    let rest = restGrid()
    let card = shown.card
    closeCard = card
    closeFrom = rest.map(card.apply)
    let presented = shown.to.count == rest.count ? shown.to : closeFrom
    closeOffsets = zip(presented, closeFrom).map { CGPoint(x: $0.x - $1.x, y: $0.y - $1.y) }
    closeAlpha = shown.cardAlpha
    closeScrim = shown.scrimAlpha
    closeChrome = shown.chromeAlpha
    closeStart = now
    warp.jump(0)
    clearResidual()
  }

  private func closeP(_ now: Double) -> Double { 1 - PeekSpring.remaining(now - closeStart, response: Self.closeResponse * slow) }

  private func entranceP(_ now: Double) -> Double { PeekSpring.remaining(now - genieStart, response: Self.genieResponse * slow) }

  private func target(for c: CGRect) -> CGRect {
    let s = geometry.source
    let w = max(s.width, c.width * Self.neckWidth)
    return CGRect(x: s.midX - w / 2, y: s.minY, width: w, height: s.height)
  }

  private func funnelGrid(card c: CGRect, p: Double) -> [CGPoint] {
    let t = target(for: c)
    return Self.grid { k, j in Self.funnelPoint(card: c, target: t, k: k, j: j, p: p) }
  }

  static func funnelPoint(card c: CGRect, target t: CGRect, k: Double, j: Double, p: Double) -> CGPoint {
    let smooth = { (v: Double) -> Double in let x = unit(v); return x * x * (3 - 2 * x) }
    let ty = t.midY
    let restY = c.minY + k * c.height
    let extent = restY < ty ? max(ty - c.minY, 1) : max(c.maxY - ty, 1)
    let near = 1 - unit(abs(restY - ty) / extent)
    let squeeze = smooth(p / squeezeLead)
    let slide = smooth((p - squeezeLead * 0.5) / (1 - squeezeLead * 0.5))
    let rowSlide = smooth(slide * (1 + rowLag) - rowLag * (1 - near))
    let y = lerp(restY, t.minY + k * t.height, rowSlide)
    let reach = 1 - smooth(abs(y - ty) / extent)
    let pinch = squeeze * lerp(reach, 1, rowSlide)
    let left = lerp(c.minX, t.minX, pinch), right = lerp(c.maxX, t.maxX, pinch)
    return CGPoint(x: lerp(left, right, j), y: y)
  }

  private func snapOpen(at now: Double) {
    phase = .open
    m.jump(0)
    presence.jump(1)
    warp.jump(0)
    clearResidual()
    fade = (1, 1, now)
  }

  private func finish(_ result: Outcome) {
    phase = .finished
    outcome = result
  }

  private func clearResidual() {
    residual = []
    alphaResidual = 0
    scrimResidual = 0
  }

  private func fadeValue(_ now: Double) -> Double {
    let p = Self.unit((now - fade.start) / Self.fadeSeconds)
    return Self.lerp(fade.from, fade.to, p)
  }




  private func restGrid() -> [CGPoint] {
    let c = geometry.card
    return Self.grid { k, j in CGPoint(x: c.minX + j * c.width, y: c.minY + k * c.height) }
  }


  private static func grid(_ point: (Double, Double) -> CGPoint) -> [CGPoint] {
    var points: [CGPoint] = []
    points.reserveCapacity((rows + 1) * (columns + 1))
    for k in 0...rows {
      for j in 0...columns { points.append(point(Double(k) / Double(rows), Double(j) / Double(columns))) }
    }
    return points
  }

  static func rubber(_ e: Double) -> Double {
    let knee = 2 - fullAt
    if e <= knee { return e }
    let u = unit((e - knee) / (2 * (fullAt - 1)))
    return knee + (1 - knee) * (2 * u - u * u)
  }
  static func unit(_ v: Double) -> Double { min(max(v, 0), 1) }
  static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
  static func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }
  static func lerp(_ a: CGRect, _ b: CGRect, _ t: Double) -> CGRect {
    CGRect(x: lerp(a.minX, b.minX, t), y: lerp(a.minY, b.minY, t), width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t))
  }
}
