import React from 'react';

interface NoteBlockProps {
  type: string;
  note: any;
  onBlockTypeChange: (blockType: string) => void;
}

const NoteBlock: React.FC<NoteBlockProps> = ({ type, note, onBlockTypeChange }) => {
  switch (type) {
    case 'text':
      return <div>{note.text}</div>;
    case 'date':
      return <div>{note.date.toLocaleDateString()}</div>;
    default:
      return <div>Unknown block type</div>;
  }
};

export default NoteBlock;