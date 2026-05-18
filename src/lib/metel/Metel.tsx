export function Metel() {
  return (
    <>
      <color attach="background" args={['#ff0000']} />
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />
      <mesh>
        <boxGeometry />
        <meshStandardMaterial color="white" />
      </mesh>
    </>
  );
}
