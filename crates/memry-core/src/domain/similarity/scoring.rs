//! Pure scoring for the note-side similarity features: tag suggestions from a
//! note's nearest neighbours, and grouping a set of notes by embedding. A port of
//! Electron's `apps/desktop/src/main/similarity/scoring.ts`.
//!
//! No database and no model: the callers read vectors and tags, this module only
//! ranks them. Every tie keeps the order Electron's stable sorts and insertion-ordered
//! maps give it.

use crate::domain::tags;

/// Only a candidate's best few similarities count, so volume alone cannot win.
const SUPPORT_CAP: usize = 3;
/// A candidate backed by a single note is discounted; corroboration removes it.
const LONE_HIT_PENALTY: f64 = 0.3;

/// Cosine similarity of two vectors over their common length, in `f64` as
/// JavaScript computes it. 0 when either has no length.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut norm_a, mut norm_b) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (f64::from(x), f64::from(y));
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b).sqrt()
}

/// One candidate's score from the similarities of the notes behind it: the mean
/// of its best [`SUPPORT_CAP`], discounted when only one or two notes agree.
/// Electron's `corroboratedSimilarity` (`inbox/folder-scoring.ts`), which the inbox
/// folder suggestions share.
pub fn corroborated_similarity(sims: &[f64]) -> f64 {
    if sims.is_empty() {
        return 0.0;
    }
    let mut top = sims.to_vec();
    top.sort_by(|a, b| b.total_cmp(a));
    top.truncate(SUPPORT_CAP);
    let mean = top.iter().sum::<f64>() / top.len() as f64;
    mean * (1.0 - LONE_HIT_PENALTY / sims.len().min(SUPPORT_CAP) as f64)
}

/// One neighbour of the note being categorised.
#[derive(Debug, Clone, PartialEq)]
pub struct TagNeighbour {
    /// Similarity to the note.
    pub similarity: f64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScoredTag {
    pub tag: String,
    /// Blended confidence, 0..1.
    pub confidence: f64,
    /// How many neighbours carry the tag.
    pub support: usize,
}

#[derive(Debug, Clone, Default)]
pub struct TagScoringOptions {
    /// Tags the note already has; never suggested again. Compared by tag identity.
    pub exclude: Vec<String>,
    /// Neighbours less similar than this are ignored entirely.
    pub min_similarity: f64,
    /// A tag needs at least this many neighbours behind it.
    pub min_support: usize,
    /// Tags below this confidence are dropped.
    pub min_confidence: f64,
    pub limit: Option<usize>,
}

/// One tag identity while [`score_neighbour_tags`] counts, in first-seen order.
struct TagEntry {
    key: String,
    sims: Vec<f64>,
    /// Each spelling with the number of neighbours that use it, first seen first.
    spellings: Vec<(String, usize)>,
}

/// Rank the tags carried by a note's nearest neighbours by
/// [`corroborated_similarity`] of the neighbours that carry each. Tags are one tag
/// per [`tags::fold`]; the spelling shown is the one most neighbours use, the first
/// seen on a tie. Highest confidence first, then most support, then first seen.
pub fn score_neighbour_tags(
    neighbours: &[TagNeighbour],
    options: &TagScoringOptions,
) -> Vec<ScoredTag> {
    let excluded: Vec<String> = options.exclude.iter().map(|t| tags::fold(t)).collect();
    let mut entries: Vec<TagEntry> = Vec::new();
    for neighbour in neighbours {
        if neighbour.similarity < options.min_similarity {
            continue;
        }
        // A note lists a tag once; guard anyway so a duplicate cannot double-count.
        let mut seen: Vec<String> = Vec::new();
        for tag in &neighbour.tags {
            let key = tags::fold(tag);
            if key.is_empty() || excluded.contains(&key) || seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            let index = match entries.iter().position(|e| e.key == key) {
                Some(index) => index,
                None => {
                    entries.push(TagEntry {
                        key,
                        sims: Vec::new(),
                        spellings: Vec::new(),
                    });
                    entries.len() - 1
                }
            };
            let entry = &mut entries[index];
            entry.sims.push(neighbour.similarity);
            match entry.spellings.iter_mut().find(|(s, _)| s == tag) {
                Some((_, count)) => *count += 1,
                None => entry.spellings.push((tag.clone(), 1)),
            }
        }
    }

    let mut scored: Vec<ScoredTag> = Vec::new();
    for TagEntry {
        sims, spellings, ..
    } in entries
    {
        if sims.len() < options.min_support {
            continue;
        }
        let confidence = corroborated_similarity(&sims);
        if confidence < options.min_confidence {
            continue;
        }
        let mut best = &spellings[0];
        for spelling in &spellings[1..] {
            if spelling.1 > best.1 {
                best = spelling;
            }
        }
        scored.push(ScoredTag {
            tag: best.0.clone(),
            confidence,
            support: sims.len(),
        });
    }
    scored.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then(b.support.cmp(&a.support))
    });
    if let Some(limit) = options.limit {
        scored.truncate(limit);
    }
    scored
}

/// The answer of [`cluster_by_similarity`], by item id.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Clusters {
    /// Groups of two or more, largest first, members in input order.
    pub groups: Vec<Vec<String>>,
    /// Items that joined no group.
    pub ungrouped: Vec<String>,
}

/// Group items by embedding with average-linkage agglomerative clustering. Every
/// item starts alone; the two groups with the highest average pairwise similarity
/// merge, repeatedly, while that average is at least `threshold`. Average linkage
/// keeps one bridging note from chaining two unrelated topics into one group.
///
/// Deterministic for a given input order: the first pair wins a tie. O(n³) in the
/// worst case, which is why callers cap n.
pub fn cluster_by_similarity(items: &[(String, Vec<f32>)], threshold: f64) -> Clusters {
    let n = items.len();
    // `link[a][b]` is the SUM of pairwise similarities between clusters a and b,
    // so the average is link / (size a * size b) and a merge is an O(n) row update.
    let mut link = vec![vec![0.0_f64; n]; n];
    for i in 0..n {
        for j in i + 1..n {
            let value = cosine_similarity(&items[i].1, &items[j].1);
            link[i][j] = value;
            link[j][i] = value;
        }
    }
    let mut members: Vec<Option<Vec<usize>>> = (0..n).map(|i| Some(vec![i])).collect();

    loop {
        let mut pick: Option<(usize, usize)> = None;
        let mut best = f64::NEG_INFINITY;
        for a in 0..n {
            let Some(ma) = &members[a] else { continue };
            for b in a + 1..n {
                let Some(mb) = &members[b] else { continue };
                let average = link[a][b] / (ma.len() * mb.len()) as f64;
                if average > best {
                    best = average;
                    pick = Some((a, b));
                }
            }
        }
        let Some((a, b)) = pick.filter(|_| best >= threshold) else {
            break;
        };
        let taken = members[b].take().unwrap_or_default();
        if let Some(merged) = members[a].as_mut() {
            merged.extend(taken);
        }
        for c in 0..n {
            if c == a || members[c].is_none() {
                continue;
            }
            link[a][c] += link[b][c];
            link[c][a] = link[a][c];
        }
    }

    let mut clusters = Clusters::default();
    for mut cluster in members.into_iter().flatten() {
        cluster.sort_unstable();
        let mut ids: Vec<String> = cluster.into_iter().map(|i| items[i].0.clone()).collect();
        if ids.len() >= 2 {
            clusters.groups.push(ids);
        } else if let Some(id) = ids.pop() {
            clusters.ungrouped.push(id);
        }
    }
    // Largest first; a stable sort keeps input order on a tie, as Electron's does.
    clusters
        .groups
        .sort_by_key(|group| std::cmp::Reverse(group.len()));
    clusters
}

/// One member of a proposed group, for [`suggest_group_name`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMember {
    pub tags: Vec<String>,
    /// The folder the note sits in, `""` at the vault root.
    pub folder: String,
}

/// A name for a proposed group from what its members share: the tag most of them
/// carry, else the last segment of the folder most of them sit in. `None` when
/// nothing is shared by at least half (and at least two). Compared by lowercase,
/// shown in the first member's spelling.
pub fn suggest_group_name(members: &[GroupMember]) -> Option<String> {
    if members.is_empty() {
        return None;
    }
    let quorum = 2.max(members.len().div_ceil(2));
    let tag = pick_shared(members.iter().map(|m| m.tags.as_slice()), quorum);
    if tag.is_some() {
        return tag;
    }
    let folders: Vec<Vec<String>> = members
        .iter()
        .map(|m| {
            if m.folder.is_empty() {
                Vec::new()
            } else {
                vec![m.folder.clone()]
            }
        })
        .collect();
    let folder = pick_shared(folders.iter().map(Vec::as_slice), quorum)?;
    Some(folder.rsplit('/').next().unwrap_or(&folder).to_owned())
}

/// The value carried by the most lists, at least `quorum` of them; the first seen
/// on a tie.
fn pick_shared<'a>(lists: impl Iterator<Item = &'a [String]>, quorum: usize) -> Option<String> {
    // (lowercase key, count, spelling), in first-seen order.
    let mut counts: Vec<(String, usize, String)> = Vec::new();
    for list in lists {
        let mut seen: Vec<String> = Vec::new();
        for value in list {
            let key = value.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            match counts.iter_mut().find(|(k, _, _)| *k == key) {
                Some((_, count, _)) => *count += 1,
                None => counts.push((key, 1, value.clone())),
            }
        }
    }
    let mut winner: Option<&(String, usize, String)> = None;
    for entry in &counts {
        if entry.1 >= quorum && winner.is_none_or(|w| entry.1 > w.1) {
            winner = Some(entry);
        }
    }
    winner.map(|w| w.2.clone())
}

#[cfg(test)]
#[path = "scoring_tests.rs"]
mod tests;
