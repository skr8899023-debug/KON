# -*- coding: utf-8 -*-
"""
build_racehorse_blender_v3.py
=============================
Builds a realistic, anatomically-proportioned grey racehorse with racing tack
(saddle, saddle cloth with number 7, bridle, reins, stirrups), studio lighting,
cameras, renders and multi-format exports.

The horse body is constructed as a single continuous anatomical loft
(muzzle -> head -> neck -> withers -> back -> croup) merged with lofted legs,
muscle-volume ellipsoids and ears, then fused into one organic surface with a
voxel remesh + smoothing pass so the result reads as sculpted, not assembled.

Run inside Blender:
    blender --background --python build_racehorse_blender_v3.py
or with the bpy python module:
    python3 build_racehorse_blender_v3.py

Environment flags:
    RACEHORSE_QUICK=1   -> low-res test render only, no exports
"""

import bpy
import bmesh
import math
import os
import sys
from math import sin, cos, pi, sqrt
from mathutils import Vector, Matrix

try:
    import numpy as np
except ImportError:
    np = None

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
QUICK = os.environ.get("RACEHORSE_QUICK", "0") == "1"
OUT_DIR = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()

NAME_BLEND = "racehorse_realistic_v3.blend"
NAME_GLB = "racehorse_realistic_v3.glb"
NAME_GLB_WEB = "racehorse_realistic_v3_web.glb"
NAME_FBX = "racehorse_realistic_v3.fbx"
NAME_OBJ = "racehorse_realistic_v3.obj"
NAME_RENDER = "racehorse_render_v3.png"
NAME_BOARD = "racehorse_preview_board_v3.png"

RING_N = 24  # loft ring resolution


# ----------------------------------------------------------------------------
# Generic helpers
# ----------------------------------------------------------------------------
def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block_list in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                       bpy.data.cameras, bpy.data.curves, bpy.data.images):
        for block in list(block_list):
            if block.users == 0:
                block_list.remove(block)


def get_collection(name):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


def link_to(obj, coll_name):
    coll = get_collection(coll_name)
    for c in obj.users_collection:
        c.objects.unlink(obj)
    coll.objects.link(obj)


def new_mesh_obj(name, bm, coll_name):
    mesh = bpy.data.meshes.new(name)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    link_to(obj, coll_name)
    return obj


def shade_smooth(obj):
    mesh = obj.data
    values = [True] * len(mesh.polygons)
    mesh.polygons.foreach_set("use_smooth", values)
    mesh.update()


def apply_modifiers(obj):
    """Apply all modifiers without relying on operator context."""
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    new_mesh = bpy.data.meshes.new_from_object(
        ev, preserve_all_data_layers=True, depsgraph=deps)
    old = obj.data
    obj.modifiers.clear()
    obj.data = new_mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)


def set_input(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value


# ----------------------------------------------------------------------------
# Loft machinery
# ----------------------------------------------------------------------------
def bridge_rings(bm, rings, cap_start=True, cap_end=True):
    """Connect a list of vertex rings with quads; optionally cap ends."""
    for a, b in zip(rings[:-1], rings[1:]):
        n = len(a)
        for i in range(n):
            v1, v2 = a[i], a[(i + 1) % n]
            v3, v4 = b[(i + 1) % n], b[i]
            try:
                bm.faces.new((v1, v2, v3, v4))
            except ValueError:
                pass
    if cap_start:
        try:
            bm.faces.new(tuple(reversed(rings[0])))
        except ValueError:
            pass
    if cap_end:
        try:
            bm.faces.new(tuple(rings[-1]))
        except ValueError:
            pass


class SpineLoft:
    """Continuous loft along a polyline path with egg-shaped sections.

    Stations: (P(Vector), w, h_top, h_bot). Path lies in the XZ plane, so the
    side axis is world Y and the section 'up' axis is perpendicular to the
    path tangent within XZ.
    """

    def __init__(self, stations):
        self.P = [Vector(s[0]) for s in stations]
        self.w = [s[1] for s in stations]
        self.ht = [s[2] for s in stations]
        self.hb = [s[3] for s in stations]
        n = len(self.P)
        self.tan = []
        for i in range(n):
            if i == 0:
                t = (self.P[1] - self.P[0])
            elif i == n - 1:
                t = (self.P[-1] - self.P[-2])
            else:
                t = (self.P[i + 1] - self.P[i - 1])
            t.normalize()
            self.tan.append(t)
        self.side = Vector((0, 1, 0))
        self.up = []
        for t in self.tan:
            u = self.side.cross(t)
            if u.z < 0:
                u = -u
            u.normalize()
            self.up.append(u)

    def _interp(self, s):
        n = len(self.P)
        s = max(0.0, min(float(s), n - 1.0001))
        i = int(s)
        f = s - i
        j = min(i + 1, n - 1)

        def L(a, b):
            return a * (1 - f) + b * f

        P = self.P[i].lerp(self.P[j], f)
        up = self.up[i].lerp(self.up[j], f).normalized()
        return P, up, L(self.w[i], self.w[j]), L(self.ht[i], self.ht[j]), L(self.hb[i], self.hb[j])

    def point(self, s, t, clearance=0.0):
        """Surface point at fractional station s, angle t (0 = top, +t = +Y side)."""
        P, up, w, ht, hb = self._interp(s)
        c = cos(t)
        h = ht if c >= 0 else hb
        p = P + self.side * (w * sin(t)) + up * (h * c)
        if clearance:
            nrm = (self.side * (sin(t) / max(w, 1e-5)) + up * (c / max(h, 1e-5)))
            nrm.normalize()
            p = p + nrm * clearance
        return p

    def build(self, bm, ring_n=RING_N):
        rings = []
        for i in range(len(self.P)):
            ring = []
            for k in range(ring_n):
                t = 2 * pi * k / ring_n
                ring.append(bm.verts.new(self.point(i, t)))
            rings.append(ring)
        bridge_rings(bm, rings)
        return rings


def add_leg_loft(bm, stations, ring_n=16):
    """Leg loft with horizontal elliptical rings.

    stations: (x, y, z, rx, ry) from top to bottom (hoof included).
    """
    rings = []
    for (x, y, z, rx, ry) in stations:
        ring = []
        for k in range(ring_n):
            t = 2 * pi * k / ring_n
            ring.append(bm.verts.new((x + rx * cos(t), y + ry * sin(t), z)))
        rings.append(ring)
    bridge_rings(bm, rings)


def add_ellipsoid(bm, center, radii, rot_euler=(0, 0, 0), segments=16):
    M = (Matrix.Translation(Vector(center)) @
         Matrix.Rotation(rot_euler[2], 4, 'Z') @
         Matrix.Rotation(rot_euler[1], 4, 'Y') @
         Matrix.Rotation(rot_euler[0], 4, 'X') @
         Matrix.Diagonal(Vector(radii).to_4d()))
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=max(8, segments - 4),
                              radius=1.0, matrix=M)


def parallel_frames(pts):
    """Parallel-transport frames along a polyline. Returns list of (tangent, nx, ny)."""
    n = len(pts)
    tans = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        t.normalize()
        tans.append(t)
    frames = []
    ref = Vector((0, 0, 1))
    if abs(tans[0].dot(ref)) > 0.9:
        ref = Vector((1, 0, 0))
    nx = tans[0].cross(ref).normalized()
    for i in range(n):
        t = tans[i]
        nx = (nx - t * nx.dot(t))
        if nx.length < 1e-6:
            nx = t.orthogonal()
        nx.normalize()
        ny = t.cross(nx).normalized()
        frames.append((t, nx.copy(), ny))
    return frames


def add_tube(bm, pts, radius, cyclic=False, ring_n=10, taper=None, cap=True):
    """Tube along polyline pts. radius: float or per-point list.
    taper: optional callable(u in 0..1) -> radius multiplier."""
    pts = [Vector(p) for p in pts]
    if cyclic:
        pts_ext = pts + [pts[0]]
    else:
        pts_ext = pts
    frames = parallel_frames(pts_ext)
    rings = []
    n = len(pts_ext)
    for i, p in enumerate(pts_ext):
        u = i / max(n - 1, 1)
        if isinstance(radius, (list, tuple)):
            r = radius[min(i, len(radius) - 1)]
        else:
            r = radius
        if taper:
            r *= taper(u)
        _, nx, ny = frames[i]
        ring = []
        for k in range(ring_n):
            a = 2 * pi * k / ring_n
            ring.append(bm.verts.new(p + nx * (r * cos(a)) + ny * (r * sin(a))))
        rings.append(ring)
    if cyclic:
        # weld: bridge last ring back to first by replacing duplicate ring
        bridge_rings(bm, rings, cap_start=False, cap_end=False)
    else:
        bridge_rings(bm, rings, cap_start=cap, cap_end=cap)


# ----------------------------------------------------------------------------
# Horse anatomy definition
# ----------------------------------------------------------------------------
# Horse faces +X. Ground at z=0. Withers ~1.60 m (thoroughbred scale).
SPINE_STATIONS = [
    # (P(x, 0, z),          w,     h_top, h_bot)
    ((-1.10, 0, 1.28), 0.085, 0.10, 0.10),   # 0  tail root (rounded)
    ((-1.02, 0, 1.14), 0.235, 0.32, 0.34),   # 1  buttock
    ((-0.80, 0, 1.13), 0.315, 0.41, 0.33),   # 2  croup peak (top ~1.54)
    ((-0.55, 0, 1.15), 0.315, 0.33, 0.30),   # 3  hip / flank (tucked)
    ((-0.30, 0, 1.15), 0.310, 0.29, 0.33),   # 4  loin
    ((-0.05, 0, 1.15), 0.330, 0.265, 0.365), # 5  barrel mid (back dip, deep girth)
    (( 0.20, 0, 1.17), 0.310, 0.30, 0.375),  # 6  girth
    (( 0.40, 0, 1.20), 0.255, 0.40, 0.37),   # 7  withers peak (top 1.60)
    (( 0.58, 0, 1.20), 0.235, 0.36, 0.35),   # 8  shoulder
    (( 0.72, 0, 1.15), 0.185, 0.30, 0.29),   # 9  chest front
    (( 0.82, 0, 1.22), 0.150, 0.235, 0.21),  # 10 base of neck
    (( 0.94, 0, 1.36), 0.122, 0.20, 0.155),  # 11 lower neck
    (( 1.05, 0, 1.55), 0.103, 0.175, 0.140), # 12 mid neck
    (( 1.14, 0, 1.72), 0.092, 0.145, 0.120), # 13 upper neck
    (( 1.215, 0, 1.86), 0.084, 0.115, 0.100),# 14 throat
    (( 1.275, 0, 1.935), 0.079, 0.105, 0.095),# 15 poll
    (( 1.355, 0, 1.835), 0.096, 0.115, 0.115),# 16 brow / forehead (widest of head)
    (( 1.425, 0, 1.725), 0.090, 0.105, 0.125),# 17 cheek / jaw
    (( 1.495, 0, 1.615), 0.070, 0.088, 0.088),# 18 mid face
    (( 1.570, 0, 1.550), 0.058, 0.073, 0.073),# 19 nose bridge
    (( 1.628, 0, 1.495), 0.051, 0.060, 0.064),# 20 muzzle
    (( 1.688, 0, 1.475), 0.044, 0.048, 0.050),# 21 muzzle tip
]

FORELEG_L = [
    # (x,     y,     z,    rx,    ry)
    (0.52, 0.185, 1.05, 0.130, 0.095),  # elbow / upper forearm (blends into body)
    (0.53, 0.185, 0.88, 0.095, 0.075),  # forearm
    (0.535, 0.180, 0.70, 0.075, 0.062), # lower forearm
    (0.54, 0.175, 0.52, 0.058, 0.052),  # above knee
    (0.545, 0.175, 0.46, 0.060, 0.055), # knee (carpus, slight bulge)
    (0.548, 0.172, 0.40, 0.044, 0.042), # cannon top
    (0.552, 0.172, 0.26, 0.040, 0.038), # cannon
    (0.556, 0.172, 0.155, 0.049, 0.046),# fetlock bulge
    (0.575, 0.172, 0.095, 0.040, 0.038),# pastern (sloped forward)
    (0.592, 0.172, 0.058, 0.046, 0.044),# coronet
    (0.600, 0.172, 0.030, 0.052, 0.049),# hoof upper
    (0.610, 0.172, 0.002, 0.058, 0.053),# hoof ground
]

HINDLEG_L = [
    (-0.80, 0.195, 1.02, 0.155, 0.110), # thigh (blends into hindquarter)
    (-0.70, 0.190, 0.80, 0.105, 0.085), # stifle area (carried forward)
    (-0.76, 0.185, 0.64, 0.080, 0.068), # gaskin
    (-0.88, 0.180, 0.51, 0.062, 0.056), # above hock
    (-0.93, 0.178, 0.45, 0.060, 0.050), # hock (point of hock)
    (-0.915, 0.175, 0.38, 0.045, 0.042),# cannon top
    (-0.895, 0.175, 0.25, 0.041, 0.039),# cannon
    (-0.875, 0.175, 0.155, 0.050, 0.047),# fetlock
    (-0.862, 0.175, 0.095, 0.041, 0.039),# pastern
    (-0.848, 0.175, 0.058, 0.047, 0.045),# coronet
    (-0.842, 0.175, 0.030, 0.053, 0.050),# hoof upper
    (-0.834, 0.175, 0.002, 0.058, 0.054),# hoof ground
]


def mirror_leg(stations):
    return [(x, -y, z, rx, ry) for (x, y, z, rx, ry) in stations]


def build_horse_body():
    """Build the fused organic horse body (single mesh)."""
    bm = bmesh.new()

    spine = SpineLoft(SPINE_STATIONS)
    spine.build(bm)

    for st in (FORELEG_L, mirror_leg(FORELEG_L), HINDLEG_L, mirror_leg(HINDLEG_L)):
        add_leg_loft(bm, st)

    # Muscle volumes fused in by the remesh pass
    for sy in (1, -1):
        # shoulder mass
        add_ellipsoid(bm, (0.55, sy * 0.185, 1.15), (0.21, 0.10, 0.27),
                      rot_euler=(0, -0.45, 0))
        # hindquarter / thigh mass
        add_ellipsoid(bm, (-0.76, sy * 0.205, 1.02), (0.29, 0.135, 0.36),
                      rot_euler=(0, 0.15, 0))
        # gaskin muscle
        add_ellipsoid(bm, (-0.77, sy * 0.19, 0.72), (0.10, 0.055, 0.14),
                      rot_euler=(0, -0.35, 0))
        # pectoral chest
        add_ellipsoid(bm, (0.70, sy * 0.10, 1.01), (0.13, 0.085, 0.14))
        # jaw / cheek plate
        add_ellipsoid(bm, (1.40, sy * 0.062, 1.71), (0.085, 0.040, 0.105),
                      rot_euler=(0, 0.9, 0))
        # ear (curved taper loft)
        ear = [
            (1.278, sy * 0.048, 1.980, 0.038, 0.028),
            (1.284, sy * 0.062, 2.090, 0.032, 0.022),
            (1.290, sy * 0.074, 2.180, 0.024, 0.015),
            (1.294, sy * 0.082, 2.250, 0.015, 0.010),
            (1.296, sy * 0.080, 2.290, 0.008, 0.006),
        ]
        add_leg_loft(bm, ear, ring_n=10)

    obj = new_mesh_obj("HORSE_BODY_MAIN", bm, "HORSE_BODY")

    # Fuse everything into one organic surface
    rm = obj.modifiers.new("Remesh", 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = 0.015 if QUICK else 0.011
    sm = obj.modifiers.new("Smooth", 'SMOOTH')
    sm.factor = 0.55
    sm.iterations = 5
    apply_modifiers(obj)
    shade_smooth(obj)
    return obj, spine


# ----------------------------------------------------------------------------
# Vertex-colour coat (dapple grey)
# ----------------------------------------------------------------------------
def paint_coat(obj):
    mesh = obj.data
    n = len(mesh.vertices)
    if np is None or n == 0:
        return
    co = np.empty(n * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]

    # base light grey with soft large-scale variation
    base = 0.48 + 0.06 * np.sin(x * 2.1 + 0.7) * np.cos(z * 2.7)
    # dapple spots over barrel & hindquarter
    dap = (np.sin(x * 21.0) * np.sin(y * 23.0 + 1.3) * np.sin(z * 19.0 + 0.5))
    dap_mask = np.clip((z - 0.75) * 2.0, 0, 1) * np.clip((0.9 - np.abs(x + 0.1)) * 1.2 + 0.4, 0, 1)
    base += 0.13 * np.clip(dap, 0, 1) * dap_mask

    r = base.copy()
    g = base.copy()
    b = base * 1.02  # cool grey

    # darker lower legs (grey TB: darker knees/points)
    leg_dark = np.clip((0.55 - z) / 0.55, 0, 1) ** 1.5
    leg_zone = ((np.abs(y) > 0.08) | (z < 0.5)) & (z < 0.85)
    f = 1.0 - 0.38 * leg_dark * leg_zone
    r *= f; g *= f; b *= f

    # hooves: near-black horn
    hoof = (z < 0.062)
    r[hoof] = 0.055; g[hoof] = 0.050; b[hoof] = 0.048

    # dark muzzle (grey horses keep dark skin on the nose)
    muz = np.clip((x - 1.53) / 0.13, 0, 1) * np.clip((1.585 - z) / 0.10, 0, 1)
    muz = np.clip(muz, 0, 1) * (z > 1.33) * (z < 1.60) * (x > 1.48)
    r = r * (1 - muz) + 0.13 * muz
    g = g * (1 - muz) + 0.12 * muz
    b = b * (1 - muz) + 0.12 * muz

    # soft dark shading around the eyes
    for sy in (1, -1):
        d2 = (x - 1.375) ** 2 + (y - sy * 0.093) ** 2 + (z - 1.815) ** 2
        eye = np.clip(1.0 - d2 / (0.055 ** 2), 0, 1)
        r *= (1 - 0.55 * eye); g *= (1 - 0.55 * eye); b *= (1 - 0.55 * eye)

    # inner-ear darkening
    for sy in (1, -1):
        d2 = (x - 1.288) ** 2 + (y - sy * 0.072) ** 2 + (z - 2.12) ** 2
        earm = np.clip(1.0 - d2 / (0.06 ** 2), 0, 1)
        r *= (1 - 0.3 * earm); g *= (1 - 0.3 * earm); b *= (1 - 0.3 * earm)

    col = mesh.color_attributes.new(name="SkinColor", type='FLOAT_COLOR', domain='POINT')
    data = np.stack([r, g, b, np.ones(n)], axis=1).astype(np.float32).ravel()
    col.data.foreach_set("color", data)
    mesh.update()


# ----------------------------------------------------------------------------
# Hair: mane, forelock, tail
# ----------------------------------------------------------------------------
def build_mane(spine):
    bm = bmesh.new()
    # ribbon draped over the LEFT side (+Y) of the neck crest
    nu, nv = 26, 7
    rings = []
    for iu in range(nu):
        u = iu / (nu - 1)
        s = 15.05 - u * (15.05 - 8.4)  # just behind the ears -> withers
        row = []
        taper = 1.0 - 0.30 * u
        for iv in range(nv):
            v = iv / (nv - 1)
            t = 0.18 + v * 1.35 * taper
            clr = 0.016 + v * 0.022
            p = spine.point(s, t, clr)
            p = p + Vector((0.004 * v * sin(u * 22 + v * 3),
                            0.003 * v * sin(u * 31), -v * v * 0.10 * taper))
            row.append(bm.verts.new(p))
        rings.append(row)
    for a, b in zip(rings[:-1], rings[1:]):
        for i in range(nv - 1):
            try:
                bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
            except ValueError:
                pass
    obj = new_mesh_obj("HORSE_MANE", bm, "HORSE_DETAILS")
    sol = obj.modifiers.new("Solidify", 'SOLIDIFY')
    sol.thickness = 0.016
    sub = obj.modifiers.new("Subd", 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    apply_modifiers(obj)
    shade_smooth(obj)

    # stray locks for a hand-groomed feel
    bm = bmesh.new()
    import random
    rnd = random.Random(7)
    for i in range(16):
        s0 = 14.9 - i * 0.42 + rnd.uniform(-0.15, 0.15)
        pts = []
        for k in range(6):
            v = k / 5
            t = 0.15 + v * 1.45
            p = spine.point(s0 + rnd.uniform(-0.1, 0.1), t, 0.020 + v * 0.026)
            p += Vector((rnd.uniform(-0.01, 0.01), 0.006 * sin(v * 9 + i), -v * v * 0.09))
            pts.append(p)
        add_tube(bm, pts, 0.009, ring_n=7, taper=lambda u: 1.0 - 0.7 * u)
    locks = new_mesh_obj("HORSE_MANE_LOCKS", bm, "HORSE_DETAILS")
    shade_smooth(locks)

    # forelock between the ears onto the forehead
    bm = bmesh.new()
    pts = [Vector((1.318, 0.012, 2.015)), Vector((1.365, 0.018, 1.955)),
           Vector((1.415, 0.010, 1.885)), Vector((1.455, 0.000, 1.825))]
    add_tube(bm, pts, 0.030, ring_n=8, taper=lambda u: 1.0 - 0.6 * u)
    fl = new_mesh_obj("HORSE_FORELOCK", bm, "HORSE_DETAILS")
    shade_smooth(fl)
    return obj


def build_tail():
    bm = bmesh.new()
    spine_pts = [
        (-1.090, 0.000, 1.31, 0.048, 0.048),
        (-1.170, 0.005, 1.14, 0.078, 0.070),
        (-1.215, -0.005, 0.94, 0.095, 0.085),
        (-1.240, 0.006, 0.70, 0.092, 0.082),
        (-1.235, -0.004, 0.48, 0.075, 0.066),
        (-1.215, 0.004, 0.32, 0.050, 0.044),
        (-1.190, 0.000, 0.22, 0.020, 0.018),
    ]
    add_leg_loft(bm, spine_pts, ring_n=12)
    # stray tail locks
    import random
    rnd = random.Random(11)
    for i in range(7):
        a = 2 * pi * i / 7
        pts = []
        for k in range(5):
            v = k / 4
            z = 1.24 - v * 0.92
            rr = 0.05 + 0.035 * sin(v * pi)
            pts.append(Vector((-1.13 - v * 0.10 + 0.01 * sin(v * 8 + i),
                               rr * sin(a) * (1 + 0.3 * v),
                               z)))
        add_tube(bm, pts, 0.020, ring_n=6, taper=lambda u: 1.0 - 0.65 * u)
    obj = new_mesh_obj("HORSE_TAIL", bm, "HORSE_DETAILS")
    disp = obj.modifiers.new("Rough", 'DISPLACE')
    tex = bpy.data.textures.new("TailNoise", 'CLOUDS')
    tex.noise_scale = 0.08
    disp.texture = tex
    disp.strength = 0.012
    sub = obj.modifiers.new("Subd", 'SUBSURF')
    sub.levels = 1
    apply_modifiers(obj)
    shade_smooth(obj)
    return obj


# ----------------------------------------------------------------------------
# Face details
# ----------------------------------------------------------------------------
def build_face_details():
    objs = {}
    for sy, suffix in ((1, "L"), (-1, "R")):
        bm = bmesh.new()
        add_ellipsoid(bm, (1.380, sy * 0.079, 1.815), (0.024, 0.022, 0.024), segments=20)
        eye = new_mesh_obj(f"HORSE_EYE_{suffix}", bm, "HORSE_BODY")
        shade_smooth(eye)
        objs[f"eye_{suffix}"] = eye

        bm = bmesh.new()
        add_ellipsoid(bm, (1.632, sy * 0.040, 1.502), (0.020, 0.011, 0.028),
                      rot_euler=(0, 0.7, sy * 0.35), segments=14)
        nos = new_mesh_obj(f"HORSE_NOSTRIL_{suffix}", bm, "HORSE_DETAILS")
        shade_smooth(nos)
        objs[f"nostril_{suffix}"] = nos
    return objs


# ----------------------------------------------------------------------------
# Tack: cloth, number, saddle, girth, stirrups, bridle
# ----------------------------------------------------------------------------
def build_saddle_cloth(spine):
    bm = bmesh.new()
    nu, nv = 18, 13
    grid = []
    for iu in range(nu):
        u = iu / (nu - 1)
        s = 5.30 + u * (8.90 - 5.30)
        edge = sqrt(max(0.0, 1.0 - (2 * (u - 0.5)) ** 2 * 0.45))
        Tmax = 1.56 * (0.80 + 0.20 * edge)
        row = []
        for iv in range(nv):
            v = iv / (nv - 1)
            t = -Tmax + v * 2 * Tmax
            p = spine.point(s, t, 0.013)
            row.append(bm.verts.new(p))
        grid.append(row)
    for a, b in zip(grid[:-1], grid[1:]):
        for i in range(nv - 1):
            try:
                bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
            except ValueError:
                pass
    obj = new_mesh_obj("TACK_CLOTH", bm, "HORSE_TACK")
    sol = obj.modifiers.new("Solidify", 'SOLIDIFY')
    sol.thickness = 0.006
    sol.offset = 1.0
    sub = obj.modifiers.new("Subd", 'SUBSURF')
    sub.levels = 2
    apply_modifiers(obj)
    shade_smooth(obj)
    return obj


def build_number_seven(spine):
    """White '7' on both sides of the saddle cloth."""
    objs = []
    for sy, suffix in ((1, "L"), (-1, "R")):
        s_mid, t_mid = 6.05, sy * 1.28
        p = spine.point(s_mid, t_mid, 0.036)
        bm = bmesh.new()
        th = 0.006
        # top bar
        bmesh.ops.create_cube(bm, size=1.0,
                              matrix=Matrix.Translation((0.0, 0, 0.092)) @
                              Matrix.Diagonal(Vector((0.135, th, 0.036)).to_4d()))
        # diagonal stroke, top joins the right end of the bar
        bmesh.ops.create_cube(bm, size=1.0,
                              matrix=Matrix.Translation((0.020, 0, -0.028)) @
                              Matrix.Rotation(math.radians(20), 4, 'Y') @
                              Matrix.Diagonal(Vector((0.040, th, 0.215)).to_4d()))
        obj = new_mesh_obj(f"TACK_NUMBER_{suffix}", bm, "HORSE_TACK")
        # keep the digit upright: face +Y on the left flank, -Y on the right
        rot = Matrix.Rotation(pi, 4, 'Z') if sy > 0 else Matrix.Identity(4)
        obj.matrix_world = Matrix.Translation(p) @ rot
        objs.append(obj)
    return objs


def build_saddle(spine):
    # seat: arch straddling the back just behind the withers
    bm = bmesh.new()
    nu, nv = 12, 9
    grid = []
    for iu in range(nu):
        u = iu / (nu - 1)
        s = 6.35 + u * (8.05 - 6.35)
        edge = (2 * (u - 0.5)) ** 2
        clr = 0.024 + 0.030 * edge ** 1.5  # pommel & cantle rise
        Tmax = 0.88 * (1.0 - 0.25 * edge)
        row = []
        for iv in range(nv):
            v = iv / (nv - 1)
            t = -Tmax + v * 2 * Tmax
            row.append(bm.verts.new(spine.point(s, t, clr)))
        grid.append(row)
    for a, b in zip(grid[:-1], grid[1:]):
        for i in range(nv - 1):
            try:
                bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
            except ValueError:
                pass
    obj = new_mesh_obj("TACK_SADDLE", bm, "HORSE_TACK")
    sol = obj.modifiers.new("Solidify", 'SOLIDIFY')
    sol.thickness = 0.022
    sub = obj.modifiers.new("Subd", 'SUBSURF')
    sub.levels = 2
    apply_modifiers(obj)
    shade_smooth(obj)

    # small knee flaps
    flaps = []
    for sy, suffix in ((1, "L"), (-1, "R")):
        bm = bmesh.new()
        nu2, nv2 = 8, 8
        grid2 = []
        for iu in range(nu2):
            u = iu / (nu2 - 1)
            s = 6.85 + u * (7.95 - 6.85)
            edge = sqrt(max(0.0, 1.0 - (2 * (u - 0.5)) ** 2))
            row = []
            for iv in range(nv2):
                v = iv / (nv2 - 1)
                t = sy * (0.84 + v * 0.46 * (0.55 + 0.45 * edge))
                row.append(bm.verts.new(spine.point(s, t, 0.021)))
            grid2.append(row)
        for a, b in zip(grid2[:-1], grid2[1:]):
            for i in range(nv2 - 1):
                try:
                    bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
                except ValueError:
                    pass
        fo = new_mesh_obj(f"TACK_FLAP_{suffix}", bm, "HORSE_TACK")
        sol = fo.modifiers.new("Solidify", 'SOLIDIFY')
        sol.thickness = 0.008
        sub = fo.modifiers.new("Subd", 'SUBSURF')
        sub.levels = 2
        apply_modifiers(fo)
        shade_smooth(fo)
        flaps.append(fo)
    return obj, flaps


def build_girth(spine):
    bm = bmesh.new()
    rings = []
    for s in (6.55, 6.75, 6.95):
        ring = []
        for k in range(RING_N):
            t = 2 * pi * k / RING_N
            ring.append(bm.verts.new(spine.point(s, t, 0.019)))
        rings.append(ring)
    bridge_rings(bm, rings, cap_start=False, cap_end=False)
    obj = new_mesh_obj("TACK_GIRTH", bm, "HORSE_TACK")
    sol = obj.modifiers.new("Solidify", 'SOLIDIFY')
    sol.thickness = 0.007
    apply_modifiers(obj)
    shade_smooth(obj)
    return obj


def build_stirrups(spine):
    objs = []
    for sy, suffix in ((1, "L"), (-1, "R")):
        top = spine.point(7.2, sy * 0.95, 0.028)
        bot = top + Vector((0, sy * 0.010, -0.13))
        bm = bmesh.new()
        # leather strap (flat tube)
        strap = [top, top.lerp(bot, 0.5), bot]
        add_tube(bm, strap, 0.014, ring_n=8)
        st = new_mesh_obj(f"TACK_STIRRUP_LEATHER_{suffix}", bm, "HORSE_TACK")
        shade_smooth(st)
        # iron: ring facing forward
        bm = bmesh.new()
        c = bot + Vector((0, 0, -0.045))
        ring_pts = [c + Vector((0.042 * cos(a), 0, 0.048 * sin(a)))
                    for a in [2 * pi * k / 20 for k in range(20)]]
        add_tube(bm, ring_pts, 0.006, cyclic=True, ring_n=8)
        ir = new_mesh_obj(f"TACK_STIRRUP_IRON_{suffix}", bm, "HORSE_TACK")
        shade_smooth(ir)
        objs += [st, ir]
    return objs


def build_bridle(spine):
    parts = []

    def tube_obj(name, pts, r, cyclic=False):
        bm = bmesh.new()
        add_tube(bm, pts, r, cyclic=cyclic, ring_n=8)
        o = new_mesh_obj(name, bm, "HORSE_TACK")
        shade_smooth(o)
        parts.append(o)
        return o

    def strap_ring(name, s, clearance, r):
        pts = [spine.point(s, 2 * pi * k / 28, clearance) for k in range(28)]
        return tube_obj(name, pts, r, cyclic=True)

    def strap_arc(name, s, t0, t1, clearance, r, n=16):
        pts = [spine.point(s, t0 + (t1 - t0) * k / (n - 1), clearance) for k in range(n)]
        return tube_obj(name, pts, r)

    # crownpiece over the poll (behind ears)
    strap_arc("TACK_BRIDLE_CROWN", 15.45, -1.55, 1.55, 0.007, 0.006, 20)
    # browband across the forehead
    strap_arc("TACK_BRIDLE_BROWBAND", 15.95, -1.35, 1.35, 0.007, 0.005, 18)
    # noseband ring around the nose bridge
    strap_ring("TACK_BRIDLE_NOSEBAND", 19.15, 0.007, 0.006)
    # throatlatch
    strap_ring("TACK_BRIDLE_THROAT", 15.55, 0.011, 0.004)

    # cheekpieces: crown end -> bit corner
    for sy, suffix in ((1, "L"), (-1, "R")):
        pts = []
        for k in range(14):
            f = k / 13
            s = 15.5 + f * (20.45 - 15.5)
            t = sy * (1.78 - 0.20 * sin(f * pi))
            pts.append(spine.point(s, t, 0.008))
        tube_obj(f"TACK_BRIDLE_CHEEK_{suffix}", pts, 0.005)

        # bit ring at the mouth corner
        c = spine.point(20.55, sy * 1.5, 0.012)
        ring_pts = [c + Vector((0.026 * cos(a), 0, 0.026 * sin(a)))
                    for a in [2 * pi * k / 18 for k in range(18)]]
        tube_obj(f"TACK_BIT_RING_{suffix}", ring_pts, 0.0045, cyclic=True)

        # rein: bit -> neck side -> withers, resting on the neck
        rein = []
        for k in range(20):
            f = k / 19
            s = 20.4 - f * (20.4 - 8.0)
            t = sy * (1.5 - 0.25 * sin(f * pi))
            sag = 0.09 * sin(f * pi)
            p = spine.point(s, t, 0.030)
            rein.append(p + Vector((0, 0, -sag)))
        tube_obj(f"TACK_REIN_{suffix}", rein, 0.0045)
    return parts


# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------
def make_material(name, base_color, roughness, metallic=0.0, use_vcol=False,
                  sheen=0.0, specular=0.5, coat_noise=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    set_input(bsdf, "Base Color", (*base_color, 1.0))
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Sheen Weight", sheen)
    set_input(bsdf, "Specular IOR Level", specular)
    if use_vcol:
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "SkinColor"
        attr.location = (-500, 300)
        if coat_noise:
            noise = nt.nodes.new("ShaderNodeTexNoise")
            noise.inputs["Scale"].default_value = 55.0
            noise.inputs["Detail"].default_value = 6.0
            noise.location = (-700, 0)
            ramp = nt.nodes.new("ShaderNodeValToRGB")
            ramp.color_ramp.elements[0].color = (0.92, 0.92, 0.92, 1)
            ramp.color_ramp.elements[1].color = (1.06, 1.06, 1.06, 1)
            ramp.location = (-500, 0)
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.inputs["Factor"].default_value = 1.0
            mix.location = (-250, 200)
            nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
            nt.links.new(attr.outputs["Color"], mix.inputs["A"])
            nt.links.new(ramp.outputs["Color"], mix.inputs["B"])
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
            # roughness breakup so the coat never looks plastic
            noise2 = nt.nodes.new("ShaderNodeTexNoise")
            noise2.inputs["Scale"].default_value = 30.0
            noise2.location = (-700, -250)
            maprange = nt.nodes.new("ShaderNodeMapRange")
            maprange.inputs["From Min"].default_value = 0.0
            maprange.inputs["From Max"].default_value = 1.0
            maprange.inputs["To Min"].default_value = 0.42
            maprange.inputs["To Max"].default_value = 0.62
            maprange.location = (-450, -250)
            nt.links.new(noise2.outputs["Fac"], maprange.inputs["Result"] if False else maprange.inputs["Value"])
            nt.links.new(maprange.outputs["Result"], bsdf.inputs["Roughness"])
        else:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def build_materials(body, mane_objs, tail, details, tack):
    m_coat = make_material("MAT_HORSE_COAT", (0.62, 0.62, 0.63), 0.5,
                           use_vcol=True, sheen=0.04, specular=0.3, coat_noise=True)
    m_hair = make_material("MAT_HAIR_DARK", (0.035, 0.032, 0.035), 0.88, sheen=0.0, specular=0.05)
    m_eye = make_material("MAT_EYE", (0.018, 0.012, 0.008), 0.1, specular=0.6)
    m_nostril = make_material("MAT_MUZZLE_DETAIL", (0.05, 0.04, 0.04), 0.8, specular=0.1)
    m_leather = make_material("MAT_TACK_LEATHER", (0.030, 0.027, 0.027), 0.55, specular=0.18)
    m_cloth = make_material("MAT_TACK_CLOTH", (0.018, 0.018, 0.022), 0.95, sheen=0.0, specular=0.03)
    m_white = make_material("MAT_NUMBER_WHITE", (0.90, 0.90, 0.90), 0.6)
    m_metal = make_material("MAT_METAL", (0.85, 0.86, 0.88), 0.25, metallic=1.0)

    assign(body, m_coat)
    for o in mane_objs:
        assign(o, m_hair)
    assign(tail, m_hair)
    for key, o in details.items():
        assign(o, m_eye if key.startswith("eye") else m_nostril)
    for o in tack:
        n = o.name
        if "NUMBER" in n:
            assign(o, m_white)
        elif "CLOTH" in n:
            assign(o, m_cloth)
        elif "IRON" in n or "BIT_RING" in n:
            assign(o, m_metal)
        else:
            assign(o, m_leather)


# ----------------------------------------------------------------------------
# Stage: ground, lights, cameras
# ----------------------------------------------------------------------------
def build_stage():
    # ground disc
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, radius=14.0, segments=64)
    ground = new_mesh_obj("GROUND_FLOOR", bm, "GROUND")
    m_ground = make_material("MAT_GROUND", (0.045, 0.045, 0.048), 0.55, specular=0.4)
    assign(ground, m_ground)
    shade_smooth(ground)

    # world: dark studio
    world = bpy.data.worlds.new("WORLD_STUDIO")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.012, 0.012, 0.014, 1.0)
    bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = world

    def area_light(name, loc, target, power, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = power
        ld.size = size
        ld.color = color
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        direction = (Vector(target) - Vector(loc)).normalized()
        lo.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        bpy.context.scene.collection.objects.link(lo)
        link_to(lo, "LIGHTING")
        return lo

    area_light("LIGHT_KEY", (3.4, 2.8, 3.2), (0.2, 0, 1.2), 420, 2.4, (1.0, 0.965, 0.92))
    area_light("LIGHT_FILL", (2.6, -3.4, 1.8), (0.2, 0, 1.1), 120, 3.5, (0.9, 0.94, 1.0))
    area_light("LIGHT_RIM", (-3.6, 1.2, 3.0), (-0.4, 0, 1.3), 340, 1.2, (1.0, 0.98, 0.95))
    area_light("LIGHT_TOP", (0.2, 0.0, 4.5), (0.2, 0, 1.0), 90, 4.0, (0.95, 0.96, 1.0))

    def camera(name, loc, target, lens):
        cd = bpy.data.cameras.new(name)
        cd.lens = lens
        co = bpy.data.objects.new(name, cd)
        co.location = loc
        direction = (Vector(target) - Vector(loc)).normalized()
        co.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        bpy.context.scene.collection.objects.link(co)
        link_to(co, "CAMERAS")
        return co

    cams = {
        "main": camera("CAM_MAIN", (4.1, 3.0, 1.75), (0.10, 0.0, 1.10), 55),
        "side": camera("CAM_SIDE", (0.15, 5.4, 1.25), (0.15, 0.0, 1.08), 60),
        "front": camera("CAM_FRONT", (5.2, 0.9, 1.55), (0.5, 0.0, 1.25), 70),
        "head": camera("CAM_HEAD", (2.9, 1.5, 1.95), (1.38, 0.0, 1.72), 85),
        "tack": camera("CAM_TACK", (1.9, 2.1, 1.65), (0.25, 0.0, 1.25), 60),
    }
    return cams


# ----------------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------------
def setup_render():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24 if QUICK else 128
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640 if QUICK else 1920
    scene.render.resolution_y = 360 if QUICK else 1080
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Base Contrast'
    scene.view_settings.exposure = -0.25


def render_to(cam, filepath, res=None, samples=None):
    scene = bpy.context.scene
    scene.camera = cam
    if res:
        scene.render.resolution_x, scene.render.resolution_y = res
    if samples:
        scene.cycles.samples = samples
    scene.render.filepath = filepath
    bpy.ops.render.render(write_still=True)


def compose_board(tile_paths, out_path, tile_w, tile_h, cols=2):
    if np is None:
        return
    rows = (len(tile_paths) + cols - 1) // cols
    board = np.zeros((rows * tile_h, cols * tile_w, 4), dtype=np.float32)
    board[..., 3] = 1.0
    for idx, p in enumerate(tile_paths):
        img = bpy.data.images.load(p)
        w, h = img.size
        buf = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        buf = buf.reshape(h, w, 4)[::-1]  # flip to top-down
        r, c = idx // cols, idx % cols
        board[r * tile_h:(r + 1) * tile_h, c * tile_w:(c + 1) * tile_w] = buf[:tile_h, :tile_w]
        bpy.data.images.remove(img)
    out = bpy.data.images.new("BOARD", width=cols * tile_w, height=rows * tile_h, alpha=True)
    out.pixels.foreach_set(board[::-1].ravel())
    out.filepath_raw = out_path
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)


# ----------------------------------------------------------------------------
# Export
# ----------------------------------------------------------------------------
def horse_objects():
    objs = []
    for cname in ("HORSE_BODY", "HORSE_DETAILS", "HORSE_TACK"):
        coll = bpy.data.collections.get(cname)
        if coll:
            objs += list(coll.objects)
    return objs


def select_only(objs):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[0]


def do_exports():
    objs = horse_objects()
    select_only(objs)

    glb = os.path.join(OUT_DIR, NAME_GLB)
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB',
                              use_selection=True, export_yup=True,
                              export_apply=True)

    fbx = os.path.join(OUT_DIR, NAME_FBX)
    bpy.ops.export_scene.fbx(filepath=fbx, use_selection=True,
                             mesh_smooth_type='FACE', path_mode='AUTO',
                             use_mesh_modifiers=True)

    obj_path = os.path.join(OUT_DIR, NAME_OBJ)
    bpy.ops.wm.obj_export(filepath=obj_path, export_selected_objects=True,
                          export_materials=True)

    # web build: decimated copy of the heavy meshes
    heavy = [o for o in objs if len(o.data.vertices) > 8000]
    for o in heavy:
        dec = o.modifiers.new("WebDecimate", 'DECIMATE')
        dec.ratio = 0.30
    select_only(objs)
    glb_web = os.path.join(OUT_DIR, NAME_GLB_WEB)
    bpy.ops.export_scene.gltf(filepath=glb_web, export_format='GLB',
                              use_selection=True, export_yup=True,
                              export_apply=True)
    for o in heavy:
        mod = o.modifiers.get("WebDecimate")
        if mod:
            o.modifiers.remove(mod)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main():
    clear_scene()
    for cname in ("HORSE_BODY", "HORSE_DETAILS", "HORSE_TACK",
                  "GROUND", "LIGHTING", "CAMERAS"):
        get_collection(cname)

    print(">> building horse body ...")
    body, spine = build_horse_body()
    print(f"   body verts: {len(body.data.vertices)}")
    paint_coat(body)

    print(">> hair ...")
    mane = build_mane(spine)
    tail = build_tail()
    mane_objs = [o for o in bpy.data.collections["HORSE_DETAILS"].objects
                 if "MANE" in o.name or "FORELOCK" in o.name]

    print(">> face details ...")
    details = build_face_details()

    print(">> tack ...")
    tack = []
    tack.append(build_saddle_cloth(spine))
    tack += build_number_seven(spine)
    saddle, flaps = build_saddle(spine)
    tack.append(saddle)
    tack += flaps
    tack.append(build_girth(spine))
    tack += build_stirrups(spine)
    tack += build_bridle(spine)

    print(">> materials ...")
    build_materials(body, mane_objs, tail, details, tack)

    print(">> stage ...")
    cams = build_stage()
    setup_render()

    print(">> main render ...")
    render_to(cams["main"], os.path.join(OUT_DIR, NAME_RENDER))

    if not QUICK:
        print(">> preview board ...")
        tw, th = 960, 540
        tiles = []
        for key in ("main", "side", "front", "head", "tack"):
            p = os.path.join(OUT_DIR, f"_tile_{key}.png")
            render_to(cams[key], p, res=(tw, th), samples=80)
            tiles.append(p)
        compose_board(tiles, os.path.join(OUT_DIR, NAME_BOARD), tw, th)
        for p in tiles:
            try:
                os.remove(p)
            except OSError:
                pass
        # restore main render settings
        bpy.context.scene.render.resolution_x = 1920
        bpy.context.scene.render.resolution_y = 1080

        print(">> exports ...")
        do_exports()

    print(">> saving .blend ...")
    bpy.context.scene.camera = cams["main"]
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, NAME_BLEND))
    print(">> DONE")


if __name__ == "__main__":
    main()
